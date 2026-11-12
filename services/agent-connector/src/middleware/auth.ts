import { Request, Response, NextFunction } from "express";
import { config } from "../config";

export function authenticate(req: Request, res: Response, next: NextFunction) {
  if (config.NODE_ENV === "test") return next();

  const authorization = req.header("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";

  if (!token || token.length !== config.CONNECTOR_API_TOKEN.length ||
      !safeEqual(token, config.CONNECTOR_API_TOKEN)) {
    return res.status(401).json({
      success: false,
      error: { code: "UNAUTHORIZED", message: "Valid connector bearer token required" }
    });
  }

  next();
}

function safeEqual(a: string, b: string): boolean {
  const crypto = require("node:crypto") as typeof import("node:crypto");
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
