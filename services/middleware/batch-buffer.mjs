// Lazy two-stage gate, stage one: a bounded ring buffer for bad requests.
//
// Immediate mode (the default) never touches this file: every detected anomaly
// is dispatched the moment it is seen, exactly as SBWK always did. In `batch`
// mode the middleware stops paging per request and just remembers it. Only when
// BATCH_MIN_BAD bad requests land inside BATCH_WINDOW_MS does the buffer hand
// one compact batch (digest + raw incidents) to Agent Core, which asks Liquid d1
// whether the pattern is worth a real LLM at all.
//
// Zero dependencies, and clock/timer injectable so the wake-up logic is testable
// without sleeping.
import { buildLogDigest, describeDigest } from "./digest.mjs";
import { classifyImpulse, explainBatch } from "./activation.mjs";

/** The only two ways it can be configured; anything else means "immediate". */
export const DETECT_MODES = ["immediate", "batch"];

/** What to do when the batch gate cannot answer (see LIQUID_BATCH_FALLBACK). */
export const BATCH_FALLBACKS = ["investigate", "skip"];

/** `batch` is opt-in; a typo must never quietly change detection behaviour. */
export function normalizeDetectMode(value) {
  return String(value ?? "").trim().toLowerCase() === "batch" ? "batch" : "immediate";
}

/** Default is `investigate`: a broken gate must not drop signal. */
export function normalizeBatchFallback(value) {
  return String(value ?? "").trim().toLowerCase() === "skip" ? "skip" : "investigate";
}

const log = (level, event, fields = {}) =>
  console.log(JSON.stringify({ level, event, service: "middleware", timestamp: new Date().toISOString(), ...fields }));

export class LogBatchBuffer {
  /**
   * @param {object} opts
   * @param {"immediate"|"batch"} [opts.mode="immediate"]
   * @param {number} [opts.minBad=5]         bad requests needed to wake up
   * @param {number} [opts.windowMs=60000]   the window that count is measured over
   * @param {number} [opts.maxSize=50]       hard cap on buffered incidents (ring)
   * @param {number} [opts.flushTimeoutMs=0] optional trickle drain (0 = off)
   * @param {number} [opts.sweepMs=1000]     how often start() re-evaluates
   * @param {number} [opts.samples=5]        samples quoted in the digest
   * @param {number} [opts.topPaths=5]       paths ranked in the digest
   * @param {(batch: object) => Promise<any>} opts.onFlush  receives { incidents, digest, meta }
   * @param {() => number} [opts.now]
   */
  constructor(opts = {}) {
    this.mode = normalizeDetectMode(opts.mode);
    this.minBad = Math.max(1, Math.floor(Number(opts.minBad) || 5));
    this.windowMs = Math.max(0, Math.floor(Number(opts.windowMs) || 0));
    this.maxSize = Math.max(1, Math.floor(Number(opts.maxSize) || 50));
    this.flushTimeoutMs = Math.max(0, Math.floor(Number(opts.flushTimeoutMs) || 0));
    this.sweepMs = Math.max(50, Math.floor(Number(opts.sweepMs) || 1000));
    this.samples = Math.max(0, Math.floor(Number(opts.samples ?? 5)));
    this.topPaths = Math.max(1, Math.floor(Number(opts.topPaths) || 5));
    // ── dumb activation rules (see activation.mjs) ──────────────────────────
    // impulse:   one severe-enough bad request bypasses the count threshold.
    // trivial:   known-noise batches are answered locally, never sent to Liquid.
    this.impulse = opts.impulse !== false;
    this.impulseSevereMs = Number.isFinite(Number(opts.impulseSevereMs)) ? Number(opts.impulseSevereMs) : 5000;
    this.impulseSevereStatuses = opts.impulseSevereStatuses !== false;
    this.skipTrivial = opts.skipTrivial === true;
    this.activation = { impulses: 0, trivialFlushes: 0, lastImpulse: null };

    this.onFlush = typeof opts.onFlush === "function" ? opts.onFlush : async () => null;
    this.now = typeof opts.now === "function" ? opts.now : () => Date.now();
    this.setIntervalImpl = opts.setIntervalImpl || globalThis.setInterval;
    this.clearIntervalImpl = opts.clearIntervalImpl || globalThis.clearInterval;

    /** @type {Array<{ at: number, incident: object }>} */
    this.entries = [];
    this.dropped = 0;   // evicted by the ring (traffic louder than maxSize)
    this.expired = 0;   // aged out of the window without ever forming a pattern
    this.flushes = 0;
    this.lastFlushAt = null;
    this.lastFlushReason = null;
    this.inFlight = null;
    this.queued = false;
    this.timer = null;
  }

  /** Immediate mode is a no-op buffer; the server checks this before buffering. */
  get enabled() { return this.mode === "batch"; }

  /**
   * Remember one detected anomaly. Never dispatches by itself and never throws:
   * a batch failure is the flusher's problem, not the request path's.
   * @returns {{ buffered: number, flush: Promise<any>|null }}
   */
  add(incident) {
    if (!this.enabled || !incident) return { buffered: this.entries.length, flush: null };
    // Recurrence is measured BEFORE this incident is buffered, so a single
    // failure is never counted as its own repeat.
    const recurrence = this.recurringOn(incident.path);
    this.entries.push({ at: this.now(), incident });
    while (this.entries.length > this.maxSize) {
      this.entries.shift();
      this.dropped += 1;
    }
    // IMPULSE rule: a single severe event (upstream down, 5xx, a path that keeps
    // breaking, a very slow response) may skip the "wait for a pattern" step.
    if (this.impulse) {
      const verdict = classifyImpulse(incident, {
        recurrence,
        severeMs: this.impulseSevereMs,
        severeStatuses: this.impulseSevereStatuses
      });
      if (verdict.impulse) {
        this.activation.impulses += 1;
        this.activation.lastImpulse = { path: incident.path, reasons: verdict.reasons, at: new Date(this.now()).toISOString() };
        return { buffered: this.entries.length, flush: this.flush("impulse") };
      }
    }
    const flush = this.maybeFlush("threshold");
    return { buffered: this.entries.length, flush };
  }

  /** How many buffered incidents already failed on the same path (recurrence). */
  recurringOn(path, exclude) {
    let n = 0;
    for (const e of this.entries) if (e.incident.path === path && e.incident !== exclude) n += 1;
    return n;
  }

  /** Count of buffered incidents that arrived inside the wake window. */
  windowCount(now = this.now()) {
    if (!this.windowMs) return this.entries.length;
    const from = now - this.windowMs;
    let n = 0;
    for (const e of this.entries) if (e.at >= from) n += 1;
    return n;
  }

  /** Has the buffer crossed the wake condition right now? */
  shouldFlush(now = this.now()) {
    if (!this.entries.length) return false;
    if (this.windowCount(now) >= this.minBad) return true;
    if (this.flushTimeoutMs > 0 && now - this.entries[0].at >= this.flushTimeoutMs) return true;
    return false;
  }

  /** Flush if (and only if) it is warranted. Safe to call on every tick. */
  maybeFlush(reason = "threshold") {
    if (!this.enabled) return null;
    if (this.inFlight) { this.queued = true; return this.inFlight; }
    const now = this.now();
    this.pruneExpired(now);
    if (!this.shouldFlush(now)) return null;
    const timedOut = this.windowCount(now) < this.minBad;
    return this.flush(timedOut ? "drain" : reason);
  }

  /** Drop incidents that can no longer contribute to a wake-up. */
  pruneExpired(now = this.now()) {
    if (!this.windowMs) return 0;
    const from = now - this.windowMs;
    let n = 0;
    while (this.entries.length && this.entries[0].at < from) { this.entries.shift(); n += 1; }
    this.expired += n;
    return n;
  }

  /**
   * Send everything buffered as ONE batch. The buffer is emptied before the
   * callback runs, so a failing batch can never loop forever on the same data.
   */
  flush(reason = "manual") {
    if (!this.enabled) return Promise.resolve(null);
    if (this.inFlight) { this.queued = true; return this.inFlight; }
    if (!this.entries.length) return Promise.resolve(null);

    const entries = this.entries;
    this.entries = [];
    const incidents = entries.map(e => e.incident);

    // TRIVIAL rule: if every incident in the batch is recognised noise (scanner
    // paths, favicon probes, plain client auth mistakes), say so locally instead
    // of spending a Liquid call on it. One real incident disables this.
    let trivial = null;
    if (this.skipTrivial) {
      const verdict = explainBatch(incidents);
      if (verdict.trivial) {
        trivial = verdict;
        this.activation.trivialFlushes += 1;
      }
    }
    const digest = buildLogDigest(incidents, {
      samples: this.samples,
      topPaths: this.topPaths,
      windowMs: this.windowMs || undefined,
      dropped: this.dropped
    });
    const meta = {
      batchId: `batch-${entries[0].at}-${this.flushes + 1}`,
      reason,
      minBad: this.minBad,
      windowMs: this.windowMs,
      buffered: incidents.length,
      flushedAt: new Date(this.now()).toISOString(),
      dropped: this.dropped,
      expired: this.expired,
      ...(trivial ? { trivial: true, trivialReason: trivial.reason, trivialCode: trivial.code, trivialByCode: trivial.byCode, trivialCount: trivial.trivialCount } : {})
    };
    this.dropped = 0;
    this.expired = 0;

    log("info", "batch_flush", {
      batchId: meta.batchId, reason, count: incidents.length,
      ...(trivial ? { trivial: true, trivialReason: trivial.reason } : {}),
      digest: describeDigest(digest)
    });

    this.inFlight = (async () => {
      try {
        return await this.onFlush({ incidents, digest, meta });
      } catch (e) {
        log("warn", "batch_flush_failed", { batchId: meta.batchId, error: e?.message || String(e) });
        return { ok: false, error: e?.message || String(e) };
      } finally {
        this.inFlight = null;
        this.flushes += 1;
        this.lastFlushAt = new Date(this.now()).toISOString();
        this.lastFlushReason = reason;
        if (this.queued) {
          this.queued = false;
          // Incidents that arrived while this batch was in flight: re-evaluate.
          const next = this.maybeFlush("threshold");
          if (next && typeof next.catch === "function") next.catch(() => {});
        }
      }
    })();
    return this.inFlight;
  }

  /** Re-evaluate on a timer so drains/expiry happen without new traffic. */
  start() {
    if (!this.enabled || this.timer) return this.timer;
    this.timer = this.setIntervalImpl(() => {
      const p = this.maybeFlush("sweep");
      if (p && typeof p.catch === "function") p.catch(() => {});
    }, this.sweepMs);
    if (typeof this.timer?.unref === "function") this.timer.unref();
    return this.timer;
  }

  stop() {
    if (this.timer) { this.clearIntervalImpl(this.timer); this.timer = null; }
  }

  /** Additive observability for `GET /_sbwk/status`. */
  stats() {
    return {
      mode: this.mode,
      enabled: this.enabled,
      buffered: this.entries.length,
      inWindow: this.enabled ? this.windowCount() : 0,
      minBad: this.minBad,
      windowMs: this.windowMs,
      maxSize: this.maxSize,
      flushTimeoutMs: this.flushTimeoutMs,
      flushes: this.flushes,
      dropped: this.dropped,
      expired: this.expired,
      lastFlushAt: this.lastFlushAt,
      lastFlushReason: this.lastFlushReason,
      inFlight: Boolean(this.inFlight),
      activation: {
        impulse: this.impulse,
        impulseSevereMs: this.impulseSevereMs,
        skipTrivial: this.skipTrivial,
        impulses: this.activation.impulses,
        trivialFlushes: this.activation.trivialFlushes,
        lastImpulse: this.activation.lastImpulse
      }
    };
  }
}
