import { test } from "node:test";
import assert from "node:assert/strict";
import { mockCheck, setMockScenario } from "../mock.mjs";
import { toolDefinitions, toFunctionTools } from "../adapters.mjs";

test("publishes only database, auth and external API read tools", () => {
  assert.equal(toolDefinitions.length, 9);
  assert.ok(toolDefinitions.every(t => t.permission === "read"));
  assert.deepEqual([...new Set(toolDefinitions.map(t => t.service))].sort(), ["auth", "database", "external_api"]);
  assert.equal(toFunctionTools().length, 9);
});

test("returns healthy mock database health in normal mode", () => {
  setMockScenario("normal");
  assert.equal(mockCheck("database", "health").status, "healthy");
});

test("detects the database failure scenario", () => {
  setMockScenario("database_failure");
  assert.equal(mockCheck("database", "health").status, "unhealthy");
  assert.equal(mockCheck("database", "metrics").data.metrics.connection_pool_usage_percent, 100);
  assert.ok(mockCheck("database", "logs").data.logs.some(l => l.level === "error"));
  setMockScenario("normal");
});

test("detects external API outage", () => {
  setMockScenario("external_api_failure");
  assert.equal(mockCheck("external_api", "health").status, "unhealthy");
  setMockScenario("normal");
});
