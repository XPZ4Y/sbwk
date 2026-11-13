// Integration tests for the Liquid -> Groq routing gate inside the investigator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInvestigator, engineerRouteResult } from "../investigate.mjs";
import { IncidentStore } from "../store.mjs";
import { heuristicReason } from "../reason.mjs";
import { notifyEngineer } from "../notify.mjs";
import { ROUTES, liquidTriage } from "../liquid.mjs";

let counter = 0;
function incident(o = {}) {
  return {
    id: `r-${counter++}`, requestId: "r", source: "middleware", detectedAt: new Date().toISOString(),
    method: "GET", path: "/users", statusCode: 500, durationMs: 10, upstream: "http://server:80",
    category: "server_error", reason: "HTTP 500", ...o
  };
}

const dbEvidence = {
  results: [
    { service: "database", check: "health", status: "unhealthy", data: { status: "unhealthy", checks: { connection_pool: "unhealthy" } } },
    { service: "auth", check: "health", status: "healthy", data: { status: "healthy" } }
  ]
};

function make({ triage, reason = async i => heuristicReason(i), config = {} } = {}) {
  const store = new IncidentStore();
  const inv = createInvestigator({
    store,
    investigateDependencies: async () => dbEvidence,
    inspectCodebase: async () => [],
    reason,
    triage,
    notifyEngineer,
    config: { ESCALATION_CONFIDENCE_THRESHOLD: 0.5, AI_DEBUG: true, ...config },
    services: ["database", "auth", "external_api"]
  });
  return { store, inv };
}

const engineerTriage = async () => ({
  provider: "liquid", model: "d1", ok: true, status: "routed", route: ROUTES.ENGINEER,
  decision: { department: "billing", departmentConfidence: 0.9, urgencyProbability: 0.97, frustrationScore: 2, frustrationLabel: "Very angry" },
  reasons: ["Liquid d1: the billing team owns this — not a code-diagnosis problem"],
  evidence: "department=billing", warnings: [], latencyMs: 210
});

const groqTriage = async () => ({
  provider: "liquid", model: "d1", ok: true, status: "routed", route: ROUTES.GROQ,
  decision: { department: "technical", departmentConfidence: 0.8, urgencyProbability: 0.2, frustrationScore: 0.2 },
  reasons: ["Liquid d1: technical diagnosis is appropriate"], evidence: "department=technical",
  warnings: [], latencyMs: 180
});

test("engineer route skips the LLM entirely and escalates", async () => {
  let reasonCalls = 0;
  const { inv } = make({ triage: engineerTriage, reason: async i => { reasonCalls++; return heuristicReason(i); } });
  const rec = await inv.runInvestigation(incident({ path: "/payouts" }));

  assert.equal(reasonCalls, 0, "the reasoner must not run when Liquid routes to a human");
  assert.equal(rec.analysis.mode, "engineer");
  assert.equal(rec.analysis.escalate, true);
  assert.match(rec.analysis.escalationReason, /billing/);
  assert.equal(rec.analysis.routing.route, "engineer");
  assert.equal(rec.analysis.routing.decision.department, "billing");
  assert.equal(rec.notification.channel === "log", true);
});

test("engineer route still produces a reviewable hand-off briefing", async () => {
  const result = engineerRouteResult({
    incident: incident({ category: "client_error", statusCode: 404 }),
    triage: { decision: { department: "sales", urgencyProbability: 0.9, frustrationScore: 2, departmentConfidence: 0.7 }, reasons: ["sales owns this"] },
    dependencyFindings: [{ service: "database", status: "healthy", signals: [] }],
    codeFindings: [{ file: "server.mjs", line: 4 }]
  });
  assert.equal(result.mode, "engineer");
  assert.equal(result.severity, "medium"); // low bumped once because urgency >= 0.8
  assert.equal(result.suggestedFixes.length, 1);
  assert.match(result.suggestedFixes[0].title, /sales/);
  assert.match(result.suggestedFixes[0].description, /server\.mjs:4/);
});

test("groq route runs the reasoner and carries the prompt metadata", async () => {
  const { inv } = make({ triage: groqTriage });
  const rec = await inv.runInvestigation(incident({ path: "/db-route" }));
  assert.equal(rec.analysis.routing.route, "groq");
  assert.equal(rec.analysis.mode, "mock");
  assert.equal(rec.analysis.prompt.profile, "balanced");
  assert.deepEqual(rec.analysis.warnings, []);
});

test("a Liquid failure is surfaced as an error warning while Groq still answers", async () => {
  const triage = async () => ({
    provider: "liquid", ok: false, status: "request_failed", route: ROUTES.GROQ, httpStatus: 500,
    decision: null, reasons: ["Liquid AI request failed"], latencyMs: 40,
    warnings: [{ severity: "error", message: "Liquid AI request failed (HTTP 500) — falling back to Groq AI." }]
  });
  const { inv } = make({ triage });
  const rec = await inv.runInvestigation(incident({ path: "/still-works" }));
  assert.equal(rec.status, "analyzed");
  assert.ok(rec.analysis.rootCause.summary, "the Groq/heuristic path must still produce a diagnosis");
  const w = rec.analysis.warnings.find(x => x.severity === "error");
  assert.ok(w, "expected a red error warning");
  assert.match(w.message, /HTTP 500/);
});

test("'Liquid not configured' is a notice, not an error", async () => {
  const triage = async () => ({
    provider: "liquid", ok: true, skipped: true, status: "not_configured", route: ROUTES.GROQ,
    decision: null, reasons: ["no Liquid triage — default route is Groq AI"], latencyMs: 0,
    warnings: [{ severity: "notice", message: "Liquid AI is not configured (LIQUID_API_KEY unset) — defaulting to Groq AI." }]
  });
  const { inv } = make({ triage });
  const rec = await inv.runInvestigation(incident());
  assert.equal(rec.analysis.warnings.length, 1);
  assert.equal(rec.analysis.warnings[0].severity, "notice");
  assert.equal(rec.analysis.routing.skipped, true);
});

test("a Groq failure adds its own warning and falls back to the heuristic", async () => {
  const reason = async i => ({ ...heuristicReason(i), llmWarning: "Groq AI call failed (timeout) — fell back to the heuristic reasoner." });
  const { inv } = make({ triage: groqTriage, reason });
  const rec = await inv.runInvestigation(incident());
  assert.equal(rec.analysis.mode, "mock");
  assert.ok(rec.analysis.confidence > 0, "heuristic still answers");
  assert.match(rec.analysis.warnings[0].message, /Groq AI call failed/);
  assert.equal(rec.analysis.warnings[0].severity, "error");
});

test("a triage client that throws cannot break the incident", async () => {
  const { inv } = make({ triage: async () => { throw new Error("boom"); } });
  const rec = await inv.runInvestigation(incident());
  assert.equal(rec.status, "analyzed");
  assert.equal(rec.analysis.routing.ok, false);
  assert.match(rec.analysis.warnings[0].message, /crashed/);
});

test("aiDebug is attached only when AI_DEBUG is enabled", async () => {
  const withDebug = make({
    triage: groqTriage,
    reason: async i => ({ ...heuristicReason(i), aiDebug: [{ provider: "groq", ok: true, request: {}, response: "{}" }] }),
    config: { AI_DEBUG: true }
  });
  const recA = await withDebug.inv.runInvestigation(incident());
  assert.equal(recA.analysis.aiDebug.length, 1);

  const withoutDebug = make({
    triage: groqTriage,
    reason: async i => ({ ...heuristicReason(i), aiDebug: [{ provider: "groq" }] }),
    config: { AI_DEBUG: false }
  });
  const recB = await withoutDebug.inv.runInvestigation(incident());
  assert.equal(recB.analysis.aiDebug, undefined);
});

test("aiDebug carries both AI calls, Liquid first", async () => {
  const answers = {
    department: { type: "choice", choice: "technical", probabilities: { billing: 0.1, technical: 0.8, sales: 0.1 }, confidence: 0.8 },
    is_urgent: { type: "noul", noul: 0.2 },
    frustration: { type: "score", score: 0.2, legend: { 0: "Calm" }, probabilities: { 0: 0.9 }, confidence: 0.9 }
  };
  const cfg = {
    LIQUID_API_KEY: "liquid_key_123456", LIQUID_ENABLED: true, LIQUID_BASE_URL: "https://api.liquid.ai",
    LIQUID_DECISIONS_PATH: "/decisions/v1/systemone", LIQUID_MODEL: "d1", LIQUID_TIMEOUT_MS: 500,
    AI_DEBUG: true, ESCALATION_CONFIDENCE_THRESHOLD: 0.5
  };
  const store = new IncidentStore();
  const inv = createInvestigator({
    store,
    investigateDependencies: async () => dbEvidence,
    inspectCodebase: async () => [],
    triage: input => liquidTriage(input, cfg, {
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ model: "d1", answers, usage: { input_tokens: 300, output_tokens: 0 } }) })
    }),
    reason: async i => ({ ...heuristicReason(i), aiDebug: [{ provider: "groq", ok: true, request: { url: "https://api.groq.com" } }] }),
    notifyEngineer,
    config: cfg,
    services: ["database"]
  });
  const rec = await inv.runInvestigation(incident({ path: "/debug-trail" }));
  const trail = rec.analysis.aiDebug;
  assert.equal(trail.length, 2);
  assert.equal(trail[0].provider, "liquid");
  assert.equal(trail[0].ok, true);
  assert.equal(trail[0].request.body.model, "d1");
  assert.ok(trail[0].response.body.length > 0);
  assert.equal(trail[1].provider, "groq");
});
