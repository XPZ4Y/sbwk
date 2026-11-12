import { describe, it, expect, beforeEach } from "vitest";
import { mockCheck } from "../src/adapters/mock.adapter";
import { setMockScenario } from "../src/adapters/mock-scenarios";
import { toolDefinitions } from "../src/registry/tool.registry";

describe("Agent Connector rollback architecture", () => {
  beforeEach(() => setMockScenario("normal"));
  it("publishes only database, auth and external API read tools", () => {
    expect(toolDefinitions).toHaveLength(9);
    expect(toolDefinitions.every(t => t.permission === "read")).toBe(true);
    expect([...new Set(toolDefinitions.map(t => t.service))].sort()).toEqual(["auth", "database", "external_api"]);
  });
  it("returns healthy mock database health in normal mode", () => {
    expect(mockCheck("database", "health").status).toBe("healthy");
  });
  it("detects the database failure scenario", () => {
    setMockScenario("database_failure");
    expect(mockCheck("database", "health").status).toBe("unhealthy");
    const metrics = mockCheck("database", "metrics").data as { metrics: Record<string, number> };
    expect(metrics.metrics.connection_pool_usage_percent).toBe(100);
    const logs = mockCheck("database", "logs").data as { logs: Array<{ level: string }> };
    expect(logs.logs.some(log => log.level === "error")).toBe(true);
  });
  it("detects external API outage", () => {
    setMockScenario("external_api_failure");
    expect(mockCheck("external_api", "health").status).toBe("unhealthy");
  });
});
