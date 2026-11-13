// services/agent-core/batch.mjs
// ---------------------------------------------------------------------------
// Stage two of the lazy two-stage gate: Liquid d1 decides whether a *pattern* of
// bad requests is worth a Groq call at all.
//
// Middleware buffers bad requests and, once BATCH_MIN_BAD of them land inside
// BATCH_WINDOW_MS, sends ONE batch here: a compact digest plus the raw
// incidents. This module then:
//
//   1. admits the batch (validation, no AI),
//   2. asks Liquid d1 a single `noul` question over the digest
//      ("do these logs look anomalous?"),
//   3. branches:
//        not anomalous → mark every incident `skipped` with a synthetic
//                        "Liquid says normal" analysis. No Groq, no
//                        notification, no cost.
//        anomalous     → run each incident through the EXISTING per-incident
//                        investigator (Liquid routing → Groq/heuristic →
//                        escalation), exactly as today. The batch stage is a
//                        pre-gate, not a parallel pipeline.
//
// If Liquid itself is unavailable (no key, disabled, timeout, HTTP error,
// unusable answer) LIQUID_BATCH_FALLBACK decides: `investigate` (default, keeps
// signal) or `skip` (accept the miss, loudly). A broken gate must never
// silently drop evidence.
//
// Nothing here touches DEFAULT_QUESTIONS / ROUTES / routeFromDecision: the batch
// question set lives in `BATCH_QUESTIONS`, and skipped incidents carry their own
// synthetic analysis shape.
import { randomUUID } from "node:crypto";
import { liquidTriage, BATCH_QUESTIONS } from "./liquid.mjs";

const log = (level, event, fields = {}) =>
  console.log(JSON.stringify({ level, event, service: "agent-core", timestamp: new Date().toISOString(), ...fields }));

/** What the batch gate decided to do with the buffered incidents. */
export const BATCH_ACTIONS = { INVESTIGATE: "investigate", SKIP: "skip" };

const truncate = (text, max) => {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max)}…[truncated ${s.length - max} chars]` : s;
};

// Services are independently deployable (own image, zero dependencies), so this
// stays local instead of importing the middleware's copy. The middleware owns
// digest *construction*; agent-core only renders the digest it receives.
const describeDigest = (digest = {}) => {
  const cats = Object.entries(digest.byCategory || {}).map(([k, v]) => `${k}=${v}`).join(", ") || "none";
  const paths = (digest.topPaths || []).slice(0, 3).map(p => `${p.path} x${p.count}`).join(", ") || "none";
  return `${digest.count || 0} bad requests (${cats}); top paths: ${paths}`;
};

/**
 * Deterministic, human-readable rendering of a log digest for d1's `state`.
 * Small on purpose: Liquid is meant to cost ~200 ms and no generated tokens, so
 * the gate gets counts and a handful of samples, never the whole firehose.
 */
export function buildBatchState(digest = {}, meta = {}, maxChars = 6000) {
  const lines = [];
  lines.push("BATCH OF BAD REQUESTS");
  lines.push(`count: ${digest.count ?? 0}`);
  if (meta.windowMs) lines.push(`window: ${meta.windowMs}ms, wake threshold: ${meta.minBad ?? "?"} bad requests`);
  if (meta.reason) lines.push(`flush reason: ${meta.reason}`);
  if (digest.dropped) lines.push(`dropped from ring buffer: ${digest.dropped}`);
  if (digest.from && digest.to) lines.push(`observed: ${digest.from} .. ${digest.to}`);

  const pairs = obj => Object.entries(obj || {}).map(([k, v]) => `${k}=${v}`).join(", ") || "none";
  lines.push(`by category: ${pairs(digest.byCategory)}`);
  lines.push(`by status: ${pairs(digest.byStatus)}`);
  lines.push(`by method: ${pairs(digest.byMethod)}`);
  if (digest.slowestMs) lines.push(`slowest request: ${Math.round(digest.slowestMs)}ms`);

  lines.push("", "TOP PATHS");
  const paths = digest.topPaths || [];
  if (!paths.length) lines.push("none");
  for (const p of paths.slice(0, 8)) {
    lines.push(`- ${p.path} x${p.count} (statuses ${pairs(p.statuses)}; categories ${pairs(p.categories)})`);
  }

  lines.push("", "SAMPLES");
  const samples = digest.samples || [];
  if (!samples.length) lines.push("none");
  for (const s of samples) {
    const bits = [`- ${s.method || "?"} ${s.path || "?"} ${s.statusCode ?? "?"}`, s.category || ""];
    if (s.durationMs !== undefined) bits.push(`${Math.round(s.durationMs)}ms`);
    if (s.reason) bits.push(`reason: ${s.reason}`);
    if (s.error) bits.push(`error: ${s.error}`);
    if (s.responseSample) bits.push(`body: ${s.responseSample}`);
    lines.push(bits.filter(Boolean).join(" · "));
  }

  return truncate(lines.join("\n"), maxChars);
}

/**
 * Pull the `noul` probability out of a Liquid triage result. Returns null when
 * the answer is missing/unusable, which the caller treats as "gapless" and
 * routes to the configured fallback.
 */
export function extractAnomalyProbability(triage = {}) {
  const answers =
    triage.decision?.raw ||
    triage.rawResponse?.answers ||
    triage.rawResponse?.decisions ||
    null;
  if (!answers || typeof answers !== "object") return null;
  const q = answers.looks_anomalous || answers.is_anomalous || answers.anomalous || {};
  const p = Number(q.noul ?? q.probability);
  return Number.isFinite(p) ? p : null;
}

/**
 * Pure policy: Liquid triage result in, batch action out. No network, no store,
 * no clock — so every branch is unit-testable.
 *
 * @returns {{action: string, reason: string, anomalyProbability: number|null, liquidStatus: string, fallback: boolean}}
 */
export function decideBatchGate({ triage = {}, threshold = 0.6, fallback = "investigate" } = {}) {
  const usable = triage.ok !== false && !triage.skipped;
  const probability = extractAnomalyProbability(triage);
  const liquidStatus = triage.status || "unknown";

  if (usable && probability !== null) {
    return probability >= threshold
      ? { action: BATCH_ACTIONS.INVESTIGATE, reason: "anomalous", anomalyProbability: probability, liquidStatus, fallback: false }
      : { action: BATCH_ACTIONS.SKIP, reason: "liquid_says_normal", anomalyProbability: probability, liquidStatus, fallback: false };
  }

  // Liquid unavailable / not configured / unusable answer → configured fallback.
  const action = fallback === BATCH_ACTIONS.SKIP ? BATCH_ACTIONS.SKIP : BATCH_ACTIONS.INVESTIGATE;
  return {
    action,
    reason: usable ? "liquid_answer_unusable" : `liquid_${liquidStatus}`,
    anomalyProbability: probability,
    liquidStatus,
    fallback: true
  };
}

/** Minimal incident validation; middleware always sends complete incidents. */
export function validateBatchIncident(b) {
  if (!b || typeof b !== "object") return "incident must be an object";
  for (const f of ["id", "requestId", "method", "path", "category", "reason", "detectedAt", "upstream"]) {
    if (typeof b[f] !== "string" || !b[f]) return `missing field: ${f}`;
  }
  if (!Number.isInteger(b.statusCode)) return "statusCode must be an integer";
  if (typeof b.durationMs !== "number") return "durationMs must be a number";
  return null;
}

/**
 * The analysis attached to incidents Liquid judged ordinary. It is synthetic on
 * purpose: no LLM ran, so the record must say so instead of pretending to be a
 * diagnosis.
 */
export function skippedAnalysis({ incident, digest = {}, gate = {}, batchId }) {
  const evidence = describeDigest(digest);
  const probability = gate.anomalyProbability;
  const why = gate.fallback
    ? `Liquid AI could not review this batch (${gate.reason}) and LIQUID_BATCH_FALLBACK=skip, so no investigation ran.`
    : `Liquid AI reviewed the batch and judged it ordinary background noise (anomaly probability ${probability}), so no investigation ran.`;
  return {
    incidentId: incident.id,
    mode: "skipped",
    severity: "low",
    summary: `Batched incident not investigated — Liquid says the pattern is normal. (${evidence})`,
    rootCause: { summary: why, confidence: 0.1 },
    suggestedFixes: [
      {
        title: "No action needed",
        description: `${why} If this turns out to be wrong, raise BATCH_MIN_BAD sensitivity or lower BATCH_LIQUID_ANOMALY_THRESHOLD so similar batches reach the investigator.`,
        kind: "investigation"
      }
    ],
    dependencyFindings: [],
    codeFindings: [],
    confidence: 0.1,
    escalate: false,
    escalationReason: undefined,
    reasoning: `Lazy batch gate: ${digest.count ?? 0} bad requests were buffered and gated before any LLM call. ${why}`,
    recurring: 0,
    routing: {
      provider: "liquid",
      model: gate.model || null,
      route: "skip",
      ok: true,
      status: gate.liquidStatus || "unknown",
      skipped: false,
      reasons: [why],
      decision: gate.anomalyProbability === null ? null : { anomalyProbability: gate.anomalyProbability },
      warnings: [],
      latencyMs: gate.latencyMs ?? null
    },
    warnings: gate.fallback
      ? [{ severity: "notice", message: `Batch gate fell back to skip (${gate.reason}); ${digest.count ?? 0} incidents were not investigated.` }]
      : [],
    batch: { batchId, action: BATCH_ACTIONS.SKIP, reason: gate.reason, threshold: gate.threshold },
    monitoringActive: false,
    createdAt: new Date().toISOString()
  };
}

/**
 * Batch gate. Dependencies are injected so this is testable without HTTP,
 * without Liquid, and without a real investigator.
 */
export function createBatchGate(deps = {}) {
  const {
    store,
    investigator,
    config = {},
    // `(state, meta) => triageResult`; defaults to the real Liquid d1 client.
    liquidGate = state => liquidTriage({}, config, { state, questions: BATCH_QUESTIONS }),
    maxIncidents = 50
  } = deps;

  const threshold = Number.isFinite(Number(config.BATCH_LIQUID_ANOMALY_THRESHOLD))
    ? Number(config.BATCH_LIQUID_ANOMALY_THRESHOLD)
    : 0.6;
  const fallback = String(config.LIQUID_BATCH_FALLBACK || "investigate").toLowerCase() === "skip" ? "skip" : "investigate";
  const limit = Math.max(1, Math.floor(Number(maxIncidents) || 50));

  const recent = [];
  const remember = entry => {
    recent.push(entry);
    while (recent.length > 50) recent.shift();
    return entry;
  };

  async function runGate(digest, meta) {
    // Respect the global monitoring switch (onboarding "start monitoring").
    if (config.MONITORING_ACTIVE === false) {
      return { action: BATCH_ACTIONS.SKIP, reason: "monitoring_inactive", anomalyProbability: null, liquidStatus: "not_called", fallback: false, threshold };
    }
    const state = buildBatchState(digest, meta, config.LIQUID_MAX_STATE_CHARS || 6000);
    let triage;
    try {
      triage = await liquidGate(state, { digest, meta });
    } catch (e) {
      triage = { provider: "liquid", ok: false, status: "client_error", skipped: false, decision: null, warnings: [{ severity: "error", message: `Batch gate crashed: ${e.message}` }] };
    }
    return decideBatchGate({ triage, threshold, fallback });
  }

  /** Mark every incident as skipped, with the synthetic "Liquid says normal" analysis. */
  function skipAll(incidents, { digest, gate, batchId }) {
    const ids = [];
    for (const incident of incidents) {
      const record = store.create(incident);
      store.annotate(record.incident.id, { batchId });
      store.attachAnalysis(record.incident.id, skippedAnalysis({ incident, digest, gate, batchId }), "skipped");
      ids.push(record.incident.id);
    }
    log("info", "batch_skipped", { batchId, count: ids.length, reason: gate.reason, anomalyProbability: gate.anomalyProbability });
    return ids;
  }

  /** Hand every buffered incident to the existing per-incident investigator. */
  async function investigateAll(incidents, { gate, batchId }) {
    const results = [];
    for (const incident of incidents) {
      try {
        const record = await investigator.runInvestigation(incident);
        // The investigator created the record; tag it so the batch is traceable.
        // (A record that already carries a batchId reached us earlier — keep it.)
        if (store.get(incident.id) && !store.get(incident.id).batchId) store.annotate(incident.id, { batchId });
        results.push({ id: incident.id, status: record?.status || "unknown", severity: record?.analysis?.severity, escalate: Boolean(record?.analysis?.escalate) });
      } catch (e) {
        log("error", "batch_investigation_failed", { batchId, incidentId: incident.id, error: e?.message || String(e) });
        results.push({ id: incident.id, status: "failed", error: e?.message || String(e) });
      }
    }
    log("info", "batch_investigated", { batchId, count: results.length, escalated: results.filter(r => r.escalate).length });
    return results;
  }

  /**
   * Process one batch. Never throws: every failure returns a result object whose
   * `action`/`reason` explains what happened to the incidents.
   *
   * @param {object} batch { batchId, digest, incidents, batch: {reason,minBad,windowMs} }
   * @param {object} opts  { awaitInvestigations }
   */
  async function process(batch = {}, opts = {}) {
    const batchId = typeof batch.batchId === "string" && batch.batchId ? batch.batchId : `batch-${randomUUID()}`;
    const rawIncidents = Array.isArray(batch.incidents) ? batch.incidents : [];
    const digest = batch.digest && typeof batch.digest === "object" ? batch.digest : {};
    const meta = { ...(batch.batch || {}), batchId };

    const accepted = [];
    const rejected = [];
    for (const incident of rawIncidents) {
      const problem = validateBatchIncident(incident);
      if (problem) rejected.push({ id: incident?.id ?? null, problem });
      else accepted.push(incident);
    }
    const incidents = accepted.slice(0, limit);
    const overflow = accepted.slice(limit).map(i => ({ id: i.id, problem: `batch limit ${limit} exceeded` }));

    if (!incidents.length) {
      const entry = remember({ batchId, at: new Date().toISOString(), action: "rejected", reason: "no valid incidents", accepted: 0, rejected: rejected.length });
      return { batchId, action: "rejected", reason: "no_valid_incidents", accepted: 0, rejected: [...rejected, ...overflow], recent: entry };
    }

    const started = Date.now();
    log("info", "batch_received", { batchId, count: incidents.length, rejected: rejected.length, digest: describeDigest(digest) });

    const gate = await runGate(digest, meta);
    gate.threshold = threshold;
    gate.model = config.LIQUID_MODEL || "d1";

    const base = {
      batchId,
      action: gate.action,
      reason: gate.reason,
      fallback: gate.fallback,
      anomalyProbability: gate.anomalyProbability,
      threshold,
      liquidStatus: gate.liquidStatus,
      accepted: incidents.length,
      rejected: [...rejected, ...overflow],
      ids: incidents.map(i => i.id)
    };

    if (gate.action === BATCH_ACTIONS.SKIP) {
      // Global switch off: record the incidents, but do not spend Liquid either.
      const zero = { action: BATCH_ACTIONS.SKIP, reason: "monitoring_inactive", anomalyProbability: gate.anomalyProbability, liquidStatus: gate.liquidStatus, threshold, model: gate.model, latencyMs: Date.now() - started };
      base.skipped = skipAll(incidents, { digest, gate: config.MONITORING_ACTIVE === false ? zero : { ...gate, latencyMs: Date.now() - started }, batchId });
      base.durationMs = Date.now() - started;
      return remember(base);
    }

    const run = investigateAll(incidents, { gate, batchId })
      .then(results => ({ ...base, investigated: results, durationMs: Date.now() - started }))
      .then(entry => remember(entry));
    if (opts.awaitInvestigations) return run;
    run.catch(e => log("error", "batch_run_failed", { batchId, error: e?.message || String(e) }));
    return { ...base, investigating: incidents.length, pending: true };
  }

  return {
    process,
    runBatch: (batch, opts) => process(batch, { ...opts, awaitInvestigations: true }),
    recent: () => recent.slice().reverse(),
    settings: () => ({ threshold, fallback, maxIncidents: limit, questions: Object.keys(BATCH_QUESTIONS) })
  };
}
