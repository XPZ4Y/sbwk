import { Router, Request, Response } from "express";
import { z } from "zod";
import { executeSchema, executeTool, investigateSchema, investigateServices } from "../services/connector.service";
import { toolDefinitions } from "../registry/tool.registry";
import { config } from "../config";

export const connectorRouter = Router();

connectorRouter.get("/tools", (_req: Request, res: Response) => {
  res.json({ success: true, tools: toolDefinitions });
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
    availableServices: ["server", "database", "auth", "external_api", "codebase", "cicd"]
  });
});
