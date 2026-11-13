// Zero-dependency config. Optionally loads a local .env (KEY=VALUE) if present.
import fs from "node:fs";
import { normalizeDetectMode, normalizeBatchFallback } from "./batch-buffer.mjs";

try {
  const txt = fs.readFileSync(new URL("./.env", import.meta.url), "utf8");
  for (const line of txt.split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch { /* no .env */ }

const env = process.env;
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v, d) => (v && v.trim() ? v : d);
const bool = (v, d) => (v === undefined ? d : ["true", "1", "yes", "on"].includes(String(v).toLowerCase()));

export const config = {
  NODE_ENV: str(env.NODE_ENV, "development"),
  PORT: num(env.PORT, 8080),
  TARGET_SERVER_URL: str(env.TARGET_SERVER_URL, "http://localhost:8000"),
  AGENT_CORE_URL: str(env.AGENT_CORE_URL, "http://localhost:4200"),
  AGENT_CORE_TOKEN: str(env.AGENT_CORE_TOKEN, "development-only-change-this-agent-token-123456"),
  MIDDLEWARE_ADMIN_TOKEN: str(env.MIDDLEWARE_ADMIN_TOKEN, "development-only-change-this-admin-token-123456"),
  DETECT_STATUS_MIN: num(env.DETECT_STATUS_MIN, 500),
  DETECT_SLOW_MS: num(env.DETECT_SLOW_MS, 0),
  DETECT_UPSTREAM_ERRORS: bool(env.DETECT_UPSTREAM_ERRORS, true),
  DISPATCH_COOLDOWN_MS: num(env.DISPATCH_COOLDOWN_MS, 15000),
  DISPATCH_TIMEOUT_MS: num(env.DISPATCH_TIMEOUT_MS, 5000),
  RESPONSE_SAMPLE_BYTES: num(env.RESPONSE_SAMPLE_BYTES, 2048),
  PROXY_TIMEOUT_MS: num(env.PROXY_TIMEOUT_MS, 30000),
  MAX_RECENT_INCIDENTS: num(env.MAX_RECENT_INCIDENTS, 200),

  // --- Lazy two-stage gate (opt-in) ----------------------------------------
  // "immediate" (default) = today's behaviour: dispatch every anomaly as it is
  // detected. "batch" = buffer bad requests and only wake the agent when a
  // PATTERN forms (BATCH_MIN_BAD inside BATCH_WINDOW_MS). Anything else falls
  // back to "immediate" so a typo can never change detection silently.
  DETECT_MODE: normalizeDetectMode(env.DETECT_MODE),
  BATCH_MIN_BAD: num(env.BATCH_MIN_BAD, 5),
  BATCH_WINDOW_MS: num(env.BATCH_WINDOW_MS, 60000),
  BATCH_MAX_SIZE: num(env.BATCH_MAX_SIZE, 50),
  // 0 = never flush a trickle; only a threshold crossing wakes the agent.
  BATCH_FLUSH_TIMEOUT_MS: num(env.BATCH_FLUSH_TIMEOUT_MS, 0),
  BATCH_SWEEP_MS: num(env.BATCH_SWEEP_MS, 1000),
  // Timeout for the whole batch round-trip (Liquid + optional investigation).
  BATCH_TIMEOUT_MS: num(env.BATCH_TIMEOUT_MS, 25000),
  // If the batch gate itself is unreachable: still run a real agent ("investigate")
  // or accept the miss ("skip"). Default keeps signal.
  LIQUID_BATCH_FALLBACK: normalizeBatchFallback(env.LIQUID_BATCH_FALLBACK)
};

if (config.NODE_ENV === "production") {
  if (config.AGENT_CORE_TOKEN.startsWith("development-only")) { console.error("Set a unique AGENT_CORE_TOKEN before production."); process.exit(1); }
  if (config.MIDDLEWARE_ADMIN_TOKEN.startsWith("development-only")) { console.error("Set a unique MIDDLEWARE_ADMIN_TOKEN before production."); process.exit(1); }
}
