import { test } from "node:test";
import assert from "node:assert/strict";
import { heuristicReason, deriveDependencyFindings } from "../reason.mjs";

function incident(o = {}) {
  return { id: "i", requestId: "r", source: "middleware", detectedAt: new Date().toISOString(), method: "GET", path: "/users", statusCode: 500, durationMs: 10, upstream: "http://server:80", category: "server_error", reason: "HTTP 500", ...o };
}

const dbFailure = {
  results: [
    { service: "database", check: "health", status: "unhealthy", data: { status: "unhealthy", checks: { connection_pool: "unhealthy" } } },
    { service: "database", check: "metrics", status: "unknown", data: { metrics: { connection_pool_usage_percent: 100, average_query_ms: 2400 } } },
    { service: "database", check: "logs", status: "unknown", data: { logs: [{ level: "error", message: "Connection pool exhausted" }] } },
    { service: "auth", check: "health", status: "healthy", data: { status: "healthy" } },
    { service: "external_api", check: "health", status: "healthy", data: { status: "healthy" } }
  ]
};

test("findings collapse per-check evidence into worst status per service", () => {
  const findings = deriveDependencyFindings(dbFailure);
  const db = findings.find(f => f.service === "database");
  assert.equal(db.status, "unhealthy");
  assert.ok(db.signals.some(s => /pool/i.test(s)));
  assert.equal(findings.find(f => f.service === "auth").status, "healthy");
});

test("attributes a 500 to an unhealthy database with high confidence", () => {
  const r = heuristicReason({ incident: incident(), dependency: dbFailure, codeFindings: [], recurring: 0 });
  assert.equal(r.mode, "mock");
  assert.equal(r.severity, "high");
  assert.match(r.rootCause.summary, /database/i);
  assert.ok(r.confidence > 0.7);
  assert.ok(r.suggestedFixes.length > 0);
});

test("attributes failures to a third-party API outage", () => {
  const dep = { results: [{ service: "external_api", check: "health", status: "unhealthy", data: { status: "unhealthy", checks: { availability: "unhealthy" } } }] };
  const r = heuristicReason({ incident: incident(), dependency: dep, codeFindings: [], recurring: 0 });
  assert.match(r.rootCause.summary, /third-party/i);
});

test("treats a 404 as a low-severity routing issue", () => {
  const r = heuristicReason({ incident: incident({ statusCode: 404, category: "client_error", path: "/missing" }), dependency: { results: [] }, codeFindings: [], recurring: 0 });
  assert.equal(r.severity, "low");
  assert.ok(r.confidence < 0.7);
});

test("is uncertain when there is no evidence", () => {
  const r = heuristicReason({ incident: incident(), dependency: { results: [] }, codeFindings: [], recurring: 0 });
  assert.ok(r.confidence < 0.5);
});

test("escalates severity for recurring failures", () => {
  const r = heuristicReason({ incident: incident({ statusCode: 404, category: "client_error", path: "/missing" }), dependency: { results: [] }, codeFindings: [], recurring: 3 });
  assert.equal(r.severity, "medium");
  assert.match(r.reasoning, /recurring/i);
});
