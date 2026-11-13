import { test } from "node:test";
import assert from "node:assert/strict";
import { BATCH_ACTIONS, buildBatchState, decideBatchGate, extractAnomalyProbability, createBatchGate, skippedAnalysis, validateBatchIncident } from "../batch.mjs";
import { BATCH_QUESTIONS, DEFAULT_QUESTIONS } from "../liquid.mjs";
import { IncidentStore } from "../store.mjs";

let counter = 0;
function incident(o = {}) {
  return {
    id: `b-${counter++}`, requestId: `r-${counter}`, source: "middleware",
    detectedAt: new Date().toISOString(), method: "GET", path: "/users", statusCode: 500,
    durationMs: 12, upstream: "http://server:80", category: "server_error",
    reason: "Upstream returned server error HTTP 500", ...o
  };
}

const digest = {
  count: 4,
  byCategory: { server_error: 4 },
  byStatus: { 500: 4 },
  byMethod: { GET: 4 },
  topPaths: [{ path: "/users", count: 4, statuses: { 500: 4 }, categories: { server_error: 4 } }],
  slowestMs: 40,
  samples: [{ method: "GET", path: "/users", statusCode: 500, category: "server_error", reason: "HTTP 500", durationMs: 12 }]
};

const triageWith = (answers, over = {}) => ({
  provider: "liquid", model: "d1", ok: true, status: "routed", skipped: false,
  route: "groq", decision: { raw: answers }, reasons: [], warnings: [], latencyMs: 120, ...over
});

/* ── the batch question is new, DEFAULT_QUESTIONS is untouched ───────────── */

test("BATCH_QUESTIONS is a separate constant and DEFAULT_QUESTIONS is unchanged", () => {
  assert.deepEqual(Object.keys(BATCH_QUESTIONS), ["looks_anomalous"]);
  assert.equal(BATCH_QUESTIONS.looks_anomalous.type, "noul");
  // Untouched: the per-incident router still sends exactly these three.
  assert.deepEqual(Object.keys(DEFAULT_QUESTIONS), ["department", "is_urgent", "frustration"]);
  assert.equal(BATCH_QUESTIONS.looks_anomalous, DEFAULT_QUESTIONS.looks_anomalous || BATCH_QUESTIONS.looks_anomalous);
});

/* ── digest → state ─────────────────────────────────────────────────────── */

test("buildBatchState renders counts, paths and samples for d1", () => {
  const state = buildBatchState(digest, { reason: "threshold", minBad: 3, windowMs: 60000 });
  assert.match(state, /BATCH OF BAD REQUESTS/);
  assert.match(state, /count: 4/);
  assert.match(state, /server_error=4/);
  assert.match(state, /status: 500=4|500=4/);
  assert.match(state, /\/users x4/);
  assert.match(state, /reason: HTTP 500/);
  assert.match(state, /wake threshold: 3/);
});

test("buildBatchState is bounded", () => {
  const big = { ...digest, samples: Array.from({ length: 50 }, (_, i) => ({ method: "GET", path: `/p${i}`, statusCode: 500, reason: "x".repeat(200) })) };
  const state = buildBatchState(big, {}, 400);
  assert.ok(state.length <= 450, `expected truncation, got ${state.length}`);
  assert.match(state, /truncated/);
});

/* ── pure policy ────────────────────────────────────────────────────────── */

test("extractAnomalyProbability reads the noul answer", () => {
  assert.equal(extractAnomalyProbability(triageWith({ looks_anomalous: { type: "noul", noul: 0.91 } })), 0.91);
  assert.equal(extractAnomalyProbability(triageWith({ looks_anomalous: { noul: 0.2 } })), 0.2);
  assert.equal(extractAnomalyProbability(triageWith({})), null);
  assert.equal(extractAnomalyProbability({ decision: null }), null);
});

test("anomalous above the threshold → investigate", () => {
  const d = decideBatchGate({ triage: triageWith({ looks_anomalous: { noul: 0.93 } }), threshold: 0.6 });
  assert.equal(d.action, BATCH_ACTIONS.INVESTIGATE);
  assert.equal(d.reason, "anomalous");
  assert.equal(d.fallback, false);
  assert.equal(d.anomalyProbability, 0.93);
});

test("not anomalous → skip, without any Groq call", () => {
  const d = decideBatchGate({ triage: triageWith({ looks_anomalous: { noul: 0.05 } }), threshold: 0.6 });
  assert.equal(d.action, BATCH_ACTIONS.SKIP);
  assert.equal(d.reason, "liquid_says_normal");
  assert.equal(d.fallback, false);
});

test("the threshold is configurable", () => {
  const triage = triageWith({ looks_anomalous: { noul: 0.4 } });
  assert.equal(decideBatchGate({ triage, threshold: 0.6 }).action, BATCH_ACTIONS.SKIP);
  assert.equal(decideBatchGate({ triage, threshold: 0.3 }).action, BATCH_ACTIONS.INVESTIGATE);
});

test("Liquid down → fallback investigate (default) keeps the signal", () => {
  for (const bad of [{ ok: false, status: "unreachable" }, { ok: false, status: "timeout" }, { ok: true, skipped: true, status: "not_configured" }]) {
    const d = decideBatchGate({ triage: { ...bad, decision: null }, fallback: "investigate" });
    assert.equal(d.action, BATCH_ACTIONS.INVESTIGATE);
    assert.equal(d.fallback, true);
    assert.match(d.reason, /^liquid_/);
  }
});

test("Liquid down → fallback skip drops it, but says so", () => {
  const d = decideBatchGate({ triage: { ok: false, status: "unreachable" }, fallback: "skip" });
  assert.equal(d.action, BATCH_ACTIONS.SKIP);
  assert.equal(d.fallback, true);
  assert.equal(d.reason, "liquid_unreachable");
});

test("a successful call with an unusable answer still falls back", () => {
  const d = decideBatchGate({ triage: triageWith({ something_else: { noul: 0.9 } }), fallback: "investigate" });
  assert.equal(d.action, BATCH_ACTIONS.INVESTIGATE);
  assert.equal(d.reason, "liquid_answer_unusable");
  assert.equal(d.fallback, true);
});

/* ── incident validation ────────────────────────────────────────────────── */

test("validateBatchIncident catches the same problems as POST /incidents", () => {
  assert.equal(validateBatchIncident(incident()), null);
  assert.match(validateBatchIncident({}), /missing field/);
  assert.match(validateBatchIncident({ ...incident(), statusCode: "500" }), /statusCode/);
  assert.match(validateBatchIncident({ ...incident(), durationMs: "12" }), /durationMs/);
});

/* ── end-to-end gate with injected dependencies ─────────────────────────── */

function makeGate({ triage, investigations = 0 } = {}) {
  const store = new IncidentStore(200);
  const ran = [];
  const investigator = {
    runInvestigation: async inc => {
      ran.push(inc.id);
      store.create(inc);
      store.attachAnalysis(inc.id, { incidentId: inc.id, mode: "mock", severity: "high", escalate: true, confidence: 0.7 });
      return store.get(inc.id);
    }
  };
  const gate = createBatchGate({
    store,
    investigator,
    config: { BATCH_LIQUID_ANOMALY_THRESHOLD: 0.6, LIQUID_BATCH_FALLBACK: "investigate", LIQUID_MODEL: "d1", MONITORING_ACTIVE: true },
    liquidGate: async () => triage,
    maxIncidents: investigations || 50
  });
  return { gate, store, ran };
}

const batchOf = n => ({
  batchId: "batch-test",
  batch: { reason: "threshold", minBad: n, windowMs: 60000 },
  digest,
  incidents: Array.from({ length: n }, () => incident())
});

test("not anomalous: incidents are stored as `skipped` with a synthetic analysis and nothing is investigated", async () => {
  const { gate, store, ran } = makeGate({ triage: triageWith({ looks_anomalous: { noul: 0.03 } }) });
  const batch = batchOf(3);
  const result = await gate.runBatch(batch);

  assert.equal(result.action, "skip");
  assert.equal(result.reason, "liquid_says_normal");
  assert.equal(result.skipped.length, 3);
  assert.equal(ran.length, 0, "no incident may reach the investigator");

  for (const inc of batch.incidents) {
    const rec = store.get(inc.id);
    assert.equal(rec.status, "skipped");
    assert.equal(rec.batchId, "batch-test");
    assert.equal(rec.analysis.mode, "skipped");
    assert.equal(rec.analysis.escalate, false);
    assert.match(rec.analysis.summary, /Liquid says the pattern is normal/i);
    assert.equal(rec.notification, undefined, "a skip must never notify anyone");
    assert.equal(rec.analysis.routing.route, "skip");
  }
  assert.equal(result.anomalyProbability, 0.03);
  assert.equal(result.threshold, 0.6);
});

test("anomalous: every buffered incident runs through the existing investigator", async () => {
  const { gate, store, ran } = makeGate({ triage: triageWith({ looks_anomalous: { noul: 0.97 } }) });
  const batch = batchOf(4);
  const result = await gate.runBatch(batch);

  assert.equal(result.action, "investigate");
  assert.equal(ran.length, 4);
  assert.equal(result.investigated.length, 4);
  assert.ok(result.investigated.every(r => r.status === "analyzed"));
  for (const inc of batch.incidents) {
    const rec = store.get(inc.id);
    assert.equal(rec.status, "analyzed");
    assert.equal(rec.batchId, "batch-test");
    assert.equal(rec.analysis.mode, "mock");
  }
});

test("default (non-awaited) mode answers immediately and keeps investigating", async () => {
  const { gate, ran } = makeGate({ triage: triageWith({ looks_anomalous: { noul: 0.97 } }) });
  const result = await gate.process(batchOf(2));
  assert.equal(result.action, "investigate");
  assert.equal(result.pending, true);
  assert.equal(result.investigating, 2);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(ran.length, 2);
});

test("Liquid unreachable + LIQUID_BATCH_FALLBACK=investigate → a real agent still runs", async () => {
  const store = new IncidentStore(200);
  const ran = [];
  const gate = createBatchGate({
    store,
    investigator: { runInvestigation: async inc => { ran.push(inc.id); store.create(inc); return store.get(inc.id); } },
    config: { BATCH_LIQUID_ANOMALY_THRESHOLD: 0.6, LIQUID_BATCH_FALLBACK: "investigate", MONITORING_ACTIVE: true },
    liquidGate: async () => ({ provider: "liquid", ok: false, status: "unreachable", decision: null, skipped: false })
  });
  const result = await gate.runBatch(batchOf(3));
  assert.equal(result.action, "investigate");
  assert.equal(result.fallback, true);
  assert.equal(result.reason, "liquid_unreachable");
  assert.equal(ran.length, 3);
});

test("Liquid unreachable + LIQUID_BATCH_FALLBACK=skip → skipped, with a loud notice", async () => {
  const store = new IncidentStore(200);
  const gate = createBatchGate({
    store,
    investigator: { runInvestigation: async () => { throw new Error("must not run"); } },
    config: { BATCH_LIQUID_ANOMALY_THRESHOLD: 0.6, LIQUID_BATCH_FALLBACK: "skip", MONITORING_ACTIVE: true },
    liquidGate: async () => ({ provider: "liquid", ok: false, status: "timeout", decision: null, skipped: false })
  });
  const batch = batchOf(2);
  const result = await gate.runBatch(batch);
  assert.equal(result.action, "skip");
  assert.equal(result.fallback, true);
  const rec = store.get(batch.incidents[0].id);
  assert.equal(rec.status, "skipped");
  assert.equal(rec.analysis.warnings[0].severity, "notice");
  assert.match(rec.analysis.warnings[0].message, /timeout/);
  assert.match(rec.analysis.rootCause.summary, /LIQUID_BATCH_FALLBACK=skip/);
});

test("not configured Liquid (no key) behaves like unavailable, never crashes", async () => {
  const store = new IncidentStore(200);
  const gate = createBatchGate({
    store,
    investigator: { runInvestigation: async inc => { store.create(inc); return store.get(inc.id); } },
    config: { LIQUID_BATCH_FALLBACK: "investigate", MONITORING_ACTIVE: true },
    liquidGate: async () => ({ provider: "liquid", ok: true, status: "not_configured", skipped: true, decision: null })
  });
  const result = await gate.runBatch(batchOf(1));
  assert.equal(result.action, "investigate");
  assert.equal(result.fallback, true);
  assert.equal(result.reason, "liquid_not_configured");
});

test("a crashing Liquid client is contained", async () => {
  const store = new IncidentStore(200);
  const gate = createBatchGate({
    store,
    investigator: { runInvestigation: async inc => { store.create(inc); return store.get(inc.id); } },
    config: { LIQUID_BATCH_FALLBACK: "investigate", MONITORING_ACTIVE: true },
    liquidGate: async () => { throw new Error("socket hang up"); }
  });
  const result = await gate.runBatch(batchOf(1));
  assert.equal(result.action, "investigate");
  assert.equal(result.reason, "liquid_client_error");
});

test("invalid incidents are rejected without touching the store", async () => {
  const { gate, store, ran } = makeGate({ triage: triageWith({ looks_anomalous: { noul: 0.99 } }) });
  const result = await gate.runBatch({ ...batchOf(0), incidents: [{ id: "bad" }, incident()] });
  assert.equal(result.accepted, 1);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].problem, /missing field/);
  assert.equal(ran.length, 1);
  assert.equal(store.get("bad"), undefined);
});

test("an empty or all-invalid batch is refused quietly", async () => {
  const { gate } = makeGate({ triage: triageWith({}) });
  const result = await gate.runBatch({ incidents: [] });
  assert.equal(result.action, "rejected");
  assert.equal(result.reason, "no_valid_incidents");
});

test("BATCH_MAX_INCIDENTS caps what one batch may cost", async () => {
  const { gate, store } = makeGate({ triage: triageWith({ looks_anomalous: { noul: 0.99 } }) });
  const batch = batchOf(5);
  const result = await gate.runBatch(batch);
  assert.equal(result.accepted, 5);
  const cappedGate = createBatchGate({
    store,
    investigator: { runInvestigation: async inc => { store.create(inc); return store.get(inc.id); } },
    config: { LIQUID_BATCH_FALLBACK: "investigate", MONITORING_ACTIVE: true },
    liquidGate: async () => triageWith({ looks_anomalous: { noul: 0.99 } }),
    maxIncidents: 2
  });
  const capped = await cappedGate.runBatch(batchOf(5));
  assert.equal(capped.accepted, 2);
  assert.equal(capped.rejected.length, 3);
  assert.match(capped.rejected[0].problem, /limit 2/);
});

test("MONITORING_ACTIVE=false records batches but never calls Liquid", async () => {
  const store = new IncidentStore(200);
  let liquidCalls = 0;
  const gate = createBatchGate({
    store,
    investigator: { runInvestigation: async () => { throw new Error("must not run"); } },
    config: { LIQUID_BATCH_FALLBACK: "investigate", MONITORING_ACTIVE: false },
    liquidGate: async () => { liquidCalls += 1; return triageWith({ looks_anomalous: { noul: 0.99 } }); }
  });
  const batch = batchOf(2);
  const result = await gate.runBatch(batch);
  assert.equal(liquidCalls, 0);
  assert.equal(result.action, "skip");
  assert.equal(result.reason, "monitoring_inactive");
  assert.equal(store.get(batch.incidents[0].id).status, "skipped");
});

test("settings() and recent() describe the gate for GET /incidents/batch", async () => {
  const { gate } = makeGate({ triage: triageWith({ looks_anomalous: { noul: 0.02 } }) });
  assert.deepEqual(gate.settings(), { threshold: 0.6, fallback: "investigate", maxIncidents: 50, questions: ["looks_anomalous"] });
  assert.deepEqual(gate.recent(), []);
  await gate.runBatch(batchOf(1));
  const [entry] = gate.recent();
  assert.equal(entry.batchId, "batch-test");
  assert.equal(entry.action, "skip");
});

test("skippedAnalysis never claims a diagnosis and never escalates", () => {
  const inc = incident();
  const a = skippedAnalysis({ incident: inc, digest, gate: { reason: "liquid_says_normal", anomalyProbability: 0.02, threshold: 0.6 }, batchId: "b1" });
  assert.equal(a.mode, "skipped");
  assert.equal(a.escalate, false);
  assert.equal(a.severity, "low");
  assert.equal(a.batch.batchId, "b1");
  assert.match(a.reasoning, /gated before any LLM call/);
});
