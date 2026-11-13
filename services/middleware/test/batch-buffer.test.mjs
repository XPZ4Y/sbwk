import { test } from "node:test";
import assert from "node:assert/strict";
import { LogBatchBuffer, normalizeDetectMode, normalizeBatchFallback, DETECT_MODES, BATCH_FALLBACKS } from "../batch-buffer.mjs";
import { buildLogDigest, describeDigest } from "../digest.mjs";

let seq = 0;
const incident = (o = {}) => ({
  id: `i-${seq++}`,
  requestId: `r-${seq}`,
  source: "middleware",
  detectedAt: new Date(1700000000000 + seq * 1000).toISOString(),
  method: "GET",
  path: "/users",
  statusCode: 500,
  durationMs: 12,
  upstream: "http://server:80",
  category: "server_error",
  reason: "Upstream returned server error HTTP 500",
  ...o
});

/** A buffer with an injected clock so "inside the window" is exact, not flaky. */
function makeBuffer(over = {}) {
  let t = 1_700_000_000_000;
  const flushed = [];
  const buf = new LogBatchBuffer({
    mode: "batch",
    minBad: 3,
    windowMs: 60_000,
    maxSize: 10,
    onFlush: async batch => { flushed.push(batch); return { ok: true }; },
    now: () => t,
    setIntervalImpl: () => null,
    clearIntervalImpl: () => {},
    ...over
  });
  return { buf, flushed, advance: ms => { t += ms; }, now: () => t };
}

/* ── defaults: nothing changes unless you opt in ─────────────────────────── */

test("DETECT_MODE defaults to immediate and anything unexpected normalises to it", () => {
  assert.deepEqual(DETECT_MODES, ["immediate", "batch"]);
  assert.equal(normalizeDetectMode(undefined), "immediate");
  assert.equal(normalizeDetectMode(""), "immediate");
  assert.equal(normalizeDetectMode("Immediate"), "immediate");
  assert.equal(normalizeDetectMode("batc"), "immediate");
  assert.equal(normalizeDetectMode("batch"), "batch");
  assert.equal(normalizeDetectMode("  BATCH "), "batch");
});

test("LIQUID_BATCH_FALLBACK defaults to investigate and only 'skip' opts out", () => {
  assert.deepEqual(BATCH_FALLBACKS, ["investigate", "skip"]);
  assert.equal(normalizeBatchFallback(undefined), "investigate");
  assert.equal(normalizeBatchFallback("nonsense"), "investigate");
  assert.equal(normalizeBatchFallback("SKIP"), "skip");
});

test("immediate mode buffers nothing: add() is a no-op and flushes never fire", async () => {
  const { buf, flushed } = makeBuffer({ mode: "immediate" });
  assert.equal(buf.enabled, false);
  for (let i = 0; i < 10; i++) buf.add(incident());
  assert.equal(buf.stats().buffered, 0);
  assert.equal(buf.maybeFlush("threshold"), null);
  assert.equal(await buf.flush("manual"), null);
  assert.equal(flushed.length, 0);
});

/* ── wake condition ──────────────────────────────────────────────────────── */

test("does not wake below BATCH_MIN_BAD", () => {
  const { buf, flushed } = makeBuffer();
  buf.add(incident());
  buf.add(incident());
  assert.equal(buf.stats().buffered, 2);
  assert.equal(flushed.length, 0);
  assert.equal(buf.shouldFlush(), false);
});

test("crossing BATCH_MIN_BAD inside the window flushes exactly once", async () => {
  const { buf, flushed } = makeBuffer();
  buf.add(incident());
  buf.add(incident());
  const { flush } = buf.add(incident());
  assert.ok(flush, "the third incident should trigger a flush");
  await flush;
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].incidents.length, 3);
  assert.equal(buf.stats().buffered, 0);
  assert.ok(flushed[0].digest.count === 3);
  assert.equal(flushed[0].meta.reason, "threshold");
});

test("crossing the threshold OUTSIDE the window does not flush", () => {
  const { buf, advance, flushed } = makeBuffer({ windowMs: 1000 });
  buf.add(incident());
  buf.add(incident());
  advance(5000); // the first two aged out of the window
  buf.add(incident());
  assert.equal(flushed.length, 0);
  assert.equal(buf.windowCount(), 1);
});

test("the window is measured on each incident's arrival time", () => {
  const { buf, advance } = makeBuffer({ minBad: 4, windowMs: 1000 });
  buf.add(incident());
  advance(400);
  buf.add(incident());
  advance(400);
  buf.add(incident());
  // all three within 800ms
  assert.equal(buf.windowCount(), 3);
  advance(1500);
  assert.equal(buf.windowCount(), 0);
});

test("incidents that age out of the window are dropped, not kept forever", () => {
  const { buf, advance } = makeBuffer({ minBad: 100, windowMs: 1000 });
  buf.add(incident());
  buf.add(incident());
  advance(2000);
  buf.pruneExpired();
  assert.equal(buf.stats().buffered, 0);
  assert.equal(buf.stats().expired, 2);
});

/* ── bounded ring ────────────────────────────────────────────────────────── */

test("the ring buffer is bounded and counts what it had to drop", () => {
  const { buf } = makeBuffer({ minBad: 1000, maxSize: 4 });
  for (let i = 0; i < 10; i++) buf.add(incident());
  const s = buf.stats();
  assert.equal(s.buffered, 4);
  assert.equal(s.dropped, 6);
});

test("a flushed digest reports the dropped count so the gate knows it saw a sample", async () => {
  const { buf, flushed } = makeBuffer({ minBad: 1000, maxSize: 2 });
  for (let i = 0; i < 5; i++) buf.add(incident());
  await buf.flush("manual");
  assert.equal(flushed[0].digest.count, 2);
  assert.equal(flushed[0].digest.dropped, 3);
});

/* ── flush mechanics ─────────────────────────────────────────────────────── */

test("flush empties the buffer before awaiting, so a failure cannot loop", async () => {
  let attempts = 0;
  const { buf } = makeBuffer({
    onFlush: async () => { attempts += 1; throw new Error("agent-core down"); }
  });
  buf.add(incident());
  buf.add(incident());
  buf.add(incident());
  await new Promise(r => setTimeout(r, 10));
  assert.equal(attempts, 1);
  assert.equal(buf.stats().buffered, 0);
  // Nothing is retried automatically: the fallback belongs to the caller.
  assert.equal(buf.maybeFlush("sweep"), null);
});

test("a batch arriving while one is in flight is queued, not dropped", async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const flushed = [];
  const { buf } = makeBuffer({
    minBad: 2,
    onFlush: async batch => { flushed.push(batch); await gate; return { ok: true }; }
  });
  buf.add(incident());
  buf.add(incident()); // triggers flush #1 (in flight)
  await new Promise(r => setTimeout(r, 5));
  buf.add(incident());
  buf.add(incident()); // should queue, not vanish
  const inFlight = buf.flush("manual");
  await new Promise(r => setTimeout(r, 5));
  release();
  await inFlight;
  await new Promise(r => setTimeout(r, 20));
  assert.equal(flushed.length, 2, "the queued batch must be sent once the first finishes");
  assert.equal(flushed[1].incidents.length, 2);
});

test("BATCH_FLUSH_TIMEOUT_MS drains a trickle that never reaches the threshold", async () => {
  const { buf, flushed, advance } = makeBuffer({ minBad: 10, flushTimeoutMs: 5000, windowMs: 600000 });
  buf.add(incident());
  assert.equal(flushed.length, 0, "nothing happens immediately");
  advance(4000);
  assert.equal(buf.maybeFlush("sweep"), null);
  advance(2000);
  const p = buf.maybeFlush("sweep");
  assert.ok(p, "the aged batch should drain");
  await p;
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].meta.reason, "drain");
});

test("flushTimeoutMs=0 (default) never drains a trickle", () => {
  const { buf, advance, flushed } = makeBuffer({ minBad: 10, flushTimeoutMs: 0, windowMs: 600000 });
  buf.add(incident());
  advance(10 * 60 * 1000);
  assert.equal(buf.maybeFlush("sweep"), null);
  assert.equal(flushed.length, 0);
});

test("stats() exposes what /_sbwk/status reports", () => {
  const { buf } = makeBuffer();
  buf.add(incident());
  const s = buf.stats();
  assert.equal(s.mode, "batch");
  assert.equal(s.enabled, true);
  assert.equal(s.minBad, 3);
  assert.equal(s.windowMs, 60000);
  assert.equal(s.buffered, 1);
  assert.equal(s.inWindow, 1);
  assert.equal(s.flushes, 0);
});

/* ── digest ──────────────────────────────────────────────────────────────── */

test("buildLogDigest summarises counts, top paths and samples", () => {
  const incidents = [
    incident({ path: "/checkout", statusCode: 500, category: "server_error" }),
    incident({ path: "/checkout", statusCode: 500, category: "server_error" }),
    incident({ path: "/checkout", statusCode: 503, category: "server_error", responseSample: "x".repeat(500) }),
    incident({ path: "/health", statusCode: 502, category: "server_error" }),
    incident({ path: "/search", statusCode: 404, category: "client_error", method: "POST" })
  ];
  const d = buildLogDigest(incidents, { samples: 2, topPaths: 2 });
  assert.equal(d.count, 5);
  assert.deepEqual(d.byCategory, { server_error: 4, client_error: 1 });
  assert.equal(d.byStatus["500"], 2);
  assert.equal(d.byMethod.POST, 1);
  assert.equal(d.topPaths[0].path, "/checkout");
  assert.equal(d.topPaths[0].count, 3);
  assert.equal(d.topPaths.length, 2);
  assert.equal(d.samples.length, 2, "samples are capped to the most recent");
  assert.equal(d.samples[1].path, "/search", "samples are the latest incidents");
  assert.ok(d.from && d.to);

  // Long bodies are clipped before they ever reach Liquid.
  const long = buildLogDigest([incident({ responseSample: "x".repeat(500) })]);
  assert.ok(long.samples[0].responseSample.length <= 241);
});

test("buildLogDigest survives empty and malformed input", () => {
  const empty = buildLogDigest([]);
  assert.equal(empty.count, 0);
  assert.deepEqual(empty.byCategory, {});
  assert.deepEqual(empty.samples, []);
  assert.equal(describeDigest(empty), "0 bad requests (none); top paths: none");
  assert.doesNotThrow(() => buildLogDigest(null));
  assert.doesNotThrow(() => buildLogDigest([null, undefined, 42]));
});
