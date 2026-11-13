import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLiquidState, extractDecision, liquidTriage, routeFromDecision,
  DEFAULT_ROUTE_POLICY, DEFAULT_QUESTIONS, ROUTES
} from "../liquid.mjs";

const incident = {
  id: "i-1", requestId: "r", source: "middleware", detectedAt: new Date().toISOString(),
  method: "POST", path: "/payouts", statusCode: 500, durationMs: 900,
  upstream: "http://server:80", category: "server_error", reason: "HTTP 500"
};

const input = {
  incident,
  dependency: {
    results: [
      { service: "database", check: "health", status: "unhealthy", data: { status: "unhealthy", checks: { connection_pool: "unhealthy" } } },
      { service: "auth", check: "health", status: "healthy", data: { status: "healthy" } }
    ]
  },
  codeFindings: [{ file: "server.mjs", line: 18, snippet: "throw new Error('pool exhausted')", reason: "pool" }],
  recurring: 2,
  recentCommits: [{ sha: "abcdef1234", message: "fix payout retries" }],
  repoUrl: "https://github.com/acme/app"
};

const answersFor = ({ department = "technical", urgent = 0.2, frustration = 0.2 } = {}) => ({
  department: { type: "choice", choice: department, probabilities: { billing: 0.1, technical: 0.8, sales: 0.1 }, confidence: 0.7 },
  is_urgent: { type: "noul", noul: urgent },
  frustration: {
    type: "score", score: frustration, legend: { 0: "Calm", 1: "Frustrated", 2: "Very angry" },
    probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 }, confidence: 0.8
  }
});

const cfgWith = over => ({
  LIQUID_API_KEY: "liquid_test_key_123456", LIQUID_ENABLED: true,
  LIQUID_BASE_URL: "https://api.liquid.ai", LIQUID_DECISIONS_PATH: "/decisions/v1/systemone",
  LIQUID_MODEL: "d1", LIQUID_TIMEOUT_MS: 500, LIQUID_MAX_STATE_CHARS: 6000,
  LIQUID_ROUTE_POLICY: undefined, LIQUID_QUESTIONS: undefined, AI_DEBUG: true,
  ...over
});

const jsonResponse = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) });

test("buildLiquidState packs the incident, dependency and code context", () => {
  const state = buildLiquidState(input);
  assert.match(state, /\/payouts/);
  assert.match(state, /status: 500/);
  assert.match(state, /database: unhealthy/);
  assert.match(state, /server\.mjs:18/);
  assert.match(state, /abcdef1/);
});

test("buildLiquidState truncates oversized context", () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ file: `f${i}.mjs`, line: i, reason: "x".repeat(80) }));
  const state = buildLiquidState({ ...input, codeFindings: many }, 500);
  assert.ok(state.length <= 540, `expected truncation, got ${state.length}`);
  assert.match(state, /truncated/);
});

test("extractDecision normalises choice / noul / score answers", () => {
  const d = extractDecision(answersFor({ department: "billing", urgent: 0.95, frustration: 1.9 }));
  assert.equal(d.department, "billing");
  assert.equal(d.urgencyProbability, 0.95);
  assert.equal(d.frustrationScore, 1.9);
  assert.equal(d.frustrationLabel, "Very angry");
  assert.equal(d.departmentConfidence, 0.7);
});

test("non-customer-facing department routes to a human", () => {
  const r = routeFromDecision(extractDecision(answersFor({ department: "billing" })));
  assert.equal(r.route, ROUTES.ENGINEER);
  assert.match(r.reasons.join(" "), /billing/i);
});

test("technical + calm routes to the Groq reasoner", () => {
  const r = routeFromDecision(extractDecision(answersFor({ department: "technical", urgent: 0.1, frustration: 0.1 })));
  assert.equal(r.route, ROUTES.GROQ);
});

test("urgent + very angry routes to a human even for technical", () => {
  const r = routeFromDecision(extractDecision(answersFor({ department: "technical", urgent: 0.93, frustration: 2 })));
  assert.equal(r.route, ROUTES.ENGINEER);
  assert.match(r.reasons.join(" "), /frustrated/i);
});

test("policy is tunable: raising the frustration threshold sends the same case to Groq", () => {
  const policy = { ...DEFAULT_ROUTE_POLICY, engineerOnUrgentFrustration: false, engineerDepartments: [] };
  const r = routeFromDecision(extractDecision(answersFor({ department: "billing", urgent: 0.99, frustration: 2 })), policy);
  assert.equal(r.route, ROUTES.GROQ);
});

test("unusable answers fall back to the policy default", () => {
  const r = routeFromDecision(extractDecision({}));
  assert.equal(r.route, ROUTES.GROQ);
  assert.match(r.evidence, /unknown/);
});

test("no LIQUID_API_KEY => default route is Groq with a notice, never an error", async () => {
  const t = await liquidTriage(input, cfgWith({ LIQUID_API_KEY: undefined }), {
    fetchImpl: async () => { throw new Error("must not be called"); }
  });
  assert.equal(t.route, ROUTES.GROQ);
  assert.equal(t.status, "not_configured");
  assert.equal(t.ok, true);
  assert.equal(t.skipped, true);
  assert.equal(t.warnings.length, 1);
  assert.equal(t.warnings[0].severity, "notice");
  assert.match(t.warnings[0].message, /Groq/i);
});

test("a successful d1 call is parsed and routed", async () => {
  let seen;
  const t = await liquidTriage(input, cfgWith(), {
    fetchImpl: async (url, init) => {
      seen = { url, body: JSON.parse(init.body), headers: init.headers };
      // billing + very angry + urgent => human
      return jsonResponse({ model: "d1", answers: answersFor({ department: "billing", urgent: 0.97, frustration: 2 }), usage: { input_tokens: 320, output_tokens: 0 } });
    }
  });
  assert.equal(seen.url, "https://api.liquid.ai/decisions/v1/systemone");
  assert.equal(seen.body.model, "d1");
  assert.equal(seen.body.questions.department.type, "choice");
  assert.equal(seen.body.questions.is_urgent.type, "noul");
  assert.equal(seen.body.questions.frustration.type, "score");
  assert.match(seen.headers.Authorization, /^Bearer liquid_/);
  assert.equal(t.route, ROUTES.ENGINEER);
  assert.equal(t.ok, true);
  assert.equal(t.decision.department, "billing");
  assert.equal(t.decision.frustrationLabel, "Very angry");
  assert.equal(t.warnings.length, 0);
});

test("HTTP failure from Liquid falls back to Groq with an error-severity warning", async () => {
  const t = await liquidTriage(input, cfgWith(), {
    fetchImpl: async () => jsonResponse({ error: "invalid api key" }, 401)
  });
  assert.equal(t.ok, false);
  assert.equal(t.route, ROUTES.GROQ);
  assert.equal(t.status, "request_failed");
  assert.equal(t.httpStatus, 401);
  assert.equal(t.warnings[0].severity, "error");
  assert.match(t.warnings[0].message, /401/);
  assert.match(t.warnings[0].message, /Groq/);
});

test("network errors and timeouts degrade to Groq instead of throwing", async () => {
  const boom = await liquidTriage(input, cfgWith(), { fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(boom.route, ROUTES.GROQ);
  assert.equal(boom.status, "unreachable");
  assert.equal(boom.warnings[0].severity, "error");

  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  const timedOut = await liquidTriage(input, cfgWith(), { fetchImpl: async () => { throw abort; } });
  assert.equal(timedOut.status, "timeout");
  assert.match(timedOut.warnings[0].message, /timed out/);
});

test("a response without answers is a failure, not a silent 'engineer'", async () => {
  const t = await liquidTriage(input, cfgWith(), { fetchImpl: async () => jsonResponse({ model: "d1" }) });
  assert.equal(t.ok, false);
  assert.equal(t.status, "no_answers");
  assert.equal(t.route, ROUTES.GROQ);
});

test("LIQUID_ENABLED=false keeps the key but skips the call", async () => {
  const t = await liquidTriage(input, cfgWith({ LIQUID_ENABLED: false }), {
    fetchImpl: async () => { throw new Error("must not be called"); }
  });
  assert.equal(t.status, "disabled");
  assert.equal(t.route, ROUTES.GROQ);
  assert.equal(t.warnings[0].severity, "notice");
});

test("the default questions match the documented System One contract", () => {
  assert.deepEqual(Object.keys(DEFAULT_QUESTIONS), ["department", "is_urgent", "frustration"]);
  assert.deepEqual(Object.keys(DEFAULT_QUESTIONS.department.criteria), ["billing", "technical", "sales"]);
  assert.deepEqual(DEFAULT_QUESTIONS.frustration.criteria, ["Calm", "Frustrated", "Very angry"]);
});
