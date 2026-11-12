import { describe, expect, it } from "vitest";
import { executeTool, investigateServices } from "../src/services/connector.service";

describe("Agent Connector", () => {
  it("executes a registered server health tool in mock mode", async () => {
    const result = await executeTool({ tool: "inspect_server_health", arguments: {} });
    expect(result.success).toBe(true);
  });

  it("rejects unknown tools", async () => {
    const result = await executeTool({ tool: "delete_database", arguments: {} });
    expect(result.success).toBe(false);
  });

  it("returns diagnostic results for selected services", async () => {
    const result = await investigateServices(["server", "database"]);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.summary.total).toBe(result.results.length);
  });
});
