import { test } from "node:test";
import assert from "node:assert/strict";
import { createInvestigator } from "../investigate.mjs";
import { IncidentStore } from "../store.mjs";
import { heuristicReason } from "../reason.mjs";
import { notifyEngineer } from "../notify.mjs";

let counter = 0;
function incident(o = {}) {
  return { id: `i-${counter++}`, requestId: "r", source: "middleware", detectedAt: new Date().toISOString(), method: "GET", path: "/users", statusCode: 500, durationMs: 10, upstream: "http://server:80", category: "server_error", reason: "HTTP 500", ...o };
}

function makeInvestigator(connectorResult) {
  const store = new IncidentStore(200);
  const inv = createInvestigator({
    store,
    investigateDependencies: async () => connectorResult,
    inspectCodebase: async () => [],
    reason: async input => heuristicReason(input),
    notifyEngineer,
    config: { ESCALATION_CONFIDENCE_THRESHOLD: 0.5 },
    services: ["database", "auth", "external_api"]
  });
  return { store, inv };
}

test("produces a confident database diagnosis without escalation", async () => {
  const { inv } = makeInvestigator({
    results: [
      { service: "database", check: "health", status: "unhealthy", data: { status: "unhealthy", checks: { connection_pool: "unhealthy" } } },
      { service: "database", check: "metrics", status: "unknown", data: { metrics: { connection_pool_usage_percent: 100 } } },
      { service: "auth", check: "health", status: "healthy", data: { status: "healthy" } },
      { service: "external_api", check: "health", status: "healthy", data: { status: "healthy" } }
    ]
  });
  const rec = await inv.runInvestigation(incident({ path: "/db-route" }));
  assert.equal(rec.status, "analyzed");
  assert.match(rec.analysis.rootCause.summary, /database/i);
  assert.equal(rec.analysis.escalate, false);
  assert.equal(rec.analysis.dependencyFindings.find(f => f.service === "database").status, "unhealthy");
});

test("escalates and notifies when the connector is unreachable", async () => {
  const { inv } = makeInvestigator({ results: [], error: "Connector unreachable" });
  const rec = await inv.runInvestigation(incident({ path: "/no-evidence" }));
  assert.equal(rec.analysis.escalate, true);
  assert.ok(rec.notification);
  assert.equal(rec.notification.channel, "log");
});

test("escalates when the application server itself is unreachable", async () => {
  const { inv } = makeInvestigator({ results: [{ service: "database", check: "health", status: "healthy", data: { status: "healthy" } }] });
  const rec = await inv.runInvestigation(incident({ path: "/server-down", category: "upstream_unreachable", statusCode: 502 }));
  assert.equal(rec.analysis.escalate, true);
  assert.match(rec.analysis.escalationReason, /server unreachable/);
});

test("recognises recurring failures on the same path", async () => {
  const { inv } = makeInvestigator({ results: [] });
  const path = "/flaky";
  let last;
  for (let i = 0; i < 4; i++) last = await inv.runInvestigation(incident({ path }));
  assert.equal(last.analysis.recurring, 3);
  assert.equal(last.analysis.escalate, true);
  assert.match(last.analysis.escalationReason, /recurring/);
});
