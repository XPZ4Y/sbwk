// Zero-dependency config. Optionally loads a local .env (KEY=VALUE) if present.
import fs from "node:fs";

try {
  const txt = fs.readFileSync(new URL("./.env", import.meta.url), "utf8");
  for (const line of txt.split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch { /* no .env — use process.env */ }

const env = process.env;
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v, d) => (v && v.trim() ? v : d);

function integration(prefix, defHealth, defMetrics, defLogs) {
  return {
    baseUrl: str(env[`${prefix}_BASE_URL`], undefined),
    token: str(env[`${prefix}_API_TOKEN`], undefined),
    paths: {
      health: str(env[`${prefix}_HEALTH_PATH`], defHealth),
      metrics: str(env[`${prefix}_METRICS_PATH`], defMetrics),
      logs: str(env[`${prefix}_LOGS_PATH`], defLogs)
    }
  };
}

export const config = {
  NODE_ENV: str(env.NODE_ENV, "development"),
  PORT: num(env.PORT, 4100),
  CONNECTOR_API_TOKEN: str(env.CONNECTOR_API_TOKEN, "development-only-change-this-token-123456"),
  CONNECTOR_MODE: env.CONNECTOR_MODE === "live" ? "live" : "mock",
  REQUEST_TIMEOUT_MS: num(env.REQUEST_TIMEOUT_MS, 4000),
  MAX_BATCH_CONCURRENCY: Math.min(num(env.MAX_BATCH_CONCURRENCY, 4), 12),
  services: {
    database: integration("DATABASE", "/internal/health", "/internal/metrics", "/internal/logs"),
    auth: integration("AUTH", "/internal/health", "/internal/metrics", "/internal/logs"),
    external_api: integration("EXTERNAL_API", "/health", "/metrics", "/logs")
  }
};

if (config.NODE_ENV === "production" && config.CONNECTOR_API_TOKEN.startsWith("development-only")) {
  console.error("Set a unique CONNECTOR_API_TOKEN before production.");
  process.exit(1);
}
