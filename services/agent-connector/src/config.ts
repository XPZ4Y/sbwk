import "dotenv/config";
import { z } from "zod";

const emptyToUndefined = (value: unknown) => typeof value === "string" && !value.trim() ? undefined : value;
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4100),
  CONNECTOR_API_TOKEN: z.string().min(32).default("development-only-change-this-token-123456"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  CONNECTOR_MODE: z.enum(["mock", "live"]).default("mock"),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
  MAX_BATCH_CONCURRENCY: z.coerce.number().int().positive().max(12).default(4),
  DATABASE_BASE_URL: optionalUrl,
  DATABASE_HEALTH_PATH: z.string().default("/internal/health"),
  DATABASE_METRICS_PATH: z.string().default("/internal/metrics"),
  DATABASE_LOGS_PATH: z.string().default("/internal/logs"),
  AUTH_BASE_URL: optionalUrl,
  AUTH_HEALTH_PATH: z.string().default("/internal/health"),
  AUTH_METRICS_PATH: z.string().default("/internal/metrics"),
  AUTH_LOGS_PATH: z.string().default("/internal/logs"),
  EXTERNAL_API_BASE_URL: optionalUrl,
  EXTERNAL_API_HEALTH_PATH: z.string().default("/health"),
  EXTERNAL_API_METRICS_PATH: z.string().default("/metrics"),
  EXTERNAL_API_LOGS_PATH: z.string().default("/logs"),
  DATABASE_API_TOKEN: optionalString,
  AUTH_API_TOKEN: optionalString,
  EXTERNAL_API_TOKEN: optionalString
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}
if (parsed.data.NODE_ENV === "production" && parsed.data.CONNECTOR_API_TOKEN === "development-only-change-this-token-123456") {
  console.error("Set a unique CONNECTOR_API_TOKEN before production.");
  process.exit(1);
}
export const config = parsed.data;
