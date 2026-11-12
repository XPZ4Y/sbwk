
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";

import { config } from "./config";
import { authenticate } from "./middleware/auth";
import { connectorRouter } from "./routes/connector.routes";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");

  app.use(helmet());

  app.use(cors({
    origin: config.CORS_ORIGIN
      .split(",")
      .map(value => value.trim()),
    methods: ["GET", "POST"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Request-Id"
    ]
  }));

  app.use(express.json({ limit: "32kb" }));

  // Request tracing and structured HTTP logging.
  app.use((req, res, next) => {
    const incomingId = req.header("x-request-id");

    const requestId =
      incomingId &&
      /^[a-zA-Z0-9._:-]{1,100}$/.test(incomingId)
        ? incomingId
        : randomUUID();

    const startedAt = process.hrtime.bigint();

    res.setHeader("X-Request-Id", requestId);

    res.on("finish", () => {
      const durationMs =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000;

      const log = {
        level: res.statusCode >= 500 ? "error" : "info",
        event: "http_request_completed",
        requestId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        timestamp: new Date().toISOString()
      };

      console.log(JSON.stringify(log));
    });

    next();
  });

  app.get("/health", (_req, res) => {
    res.json({
      success: true,
      service: "agent-connector",
      status: "healthy"
    });
  });

  app.use("/connector", rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: "draft-7",
    legacyHeaders: false
  }));

  app.use("/connector", authenticate, connectorRouter);

  app.use((_req, res) => {
    res.status(404).json({
      success: false,
      error: {
        code: "NOT_FOUND",
        message: "Route not found"
      }
    });
  });

  return app;
}
