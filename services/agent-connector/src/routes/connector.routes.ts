import { Router, Request, Response } from "express";
import { z } from "zod";
import { executeSchema, executeTool, investigateSchema, investigateServices } from "../services/connector.service";
import { toolDefinitions, toFunctionTools } from "../registry/tool.registry";
import { config } from "../config";
import { getMockScenario, mockScenarios, setMockScenario } from "../adapters/mock-scenarios";

export const connectorRouter = Router();

const demoScenarioSchema = z.object({
  scenario: z.enum(mockScenarios)
}).strict();

// Demo controls only mutate in-memory mock data. They are unavailable in live mode.
connectorRouter.get("/demo/scenario", (_req: Request, res: Response) => {
  if (config.CONNECTOR_MODE !== "mock") {
    return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Demo controls are disabled in live mode" } });
  }
  return res.json({ success: true, scenario: getMockScenario(), availableScenarios: mockScenarios });
});

connectorRouter.post("/demo/scenario", (req: Request, res: Response) => {
  if (config.CONNECTOR_MODE !== "mock") {
    return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Demo controls are disabled in live mode" } });
  }
  const parsed = demoScenarioSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Unknown demo scenario", details: parsed.error.flatten() } });
  }
  return res.json({ success: true, scenario: setMockScenario(parsed.data.scenario) });
});


connectorRouter.get("/tools", (req: Request, res: Response) => {
  const format = req.query.format;
  if (format !== undefined && format !== "native" && format !== "openai") {
    return res.status(400).json({
      success: false,
      error: { code: "INVALID_FORMAT", message: "format must be native or openai" }
    });
  }

  if (format === "openai") {
    return res.json({
      success: true,
      providerFormat: "openai-function-tools",
      readOnly: true,
      tools: toFunctionTools()
    });
  }

  return res.json({
    success: true,
    name: "sleepy-bot-agent-connector",
    version: "1.1.0",
    readOnly: true,
    invocation: { method: "POST", path: "/connector/execute" },
    tools: toolDefinitions
  });
});

connectorRouter.post("/execute", async (req: Request, res: Response) => {
  const parsed = executeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "Invalid tool request", details: parsed.error.flatten() }
    });
  }

  const result = await executeTool(parsed.data);
  return res.status(result.success ? 200 : 400).json(result);
});

connectorRouter.post("/investigate", async (req: Request, res: Response) => {
  const parsed = investigateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "Invalid investigation request", details: parsed.error.flatten() }
    });
  }

  const result = await investigateServices(parsed.data.services);
  return res.json({ success: true, ...result });
});

connectorRouter.get("/status", (_req: Request, res: Response) => {
  res.json({
    success: true,
    connector: "sleepy-bot-agent-connector",
    mode: config.CONNECTOR_MODE,
    readOnly: true,
    availableServices: ["database", "auth", "external_api"]
  });
});
