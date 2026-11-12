
import "dotenv/config";
import { z } from "zod";

// Converts empty environment variables into undefined.
// This allows optional URLs and strings to be genuinely optional.
const emptyToUndefined = (value: unknown) => {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }

  return value;
};

// Reusable optional validators
const optionalUrl = z.preprocess(
  emptyToUndefined,
  z.string().url().optional()
);

const optionalString = z.preprocess(
  emptyToUndefined,
  z.string().optional()
);

const envSchema = z.object({
  // Application configuration
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  PORT: z.coerce.number().int().positive().default(4100),

  CONNECTOR_API_TOKEN: z
    .string()
    .min(32, "Connector token must contain at least 32 characters")
    .default("development-only-change-this-token-123456"),

  CORS_ORIGIN: z.string().default("http://localhost:3000"),

  CONNECTOR_MODE: z
    .enum(["mock", "live"])
    .default("mock"),

  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),

  MAX_BATCH_CONCURRENCY: z
    .coerce.number()
    .int()
    .positive()
    .max(12)
    .default(4),

  // Application server
  SERVER_BASE_URL: optionalUrl,
  SERVER_HEALTH_PATH: z.string().default("/internal/health"),
  SERVER_METRICS_PATH: z.string().default("/internal/metrics"),
  SERVER_LOGS_PATH: z.string().default("/internal/logs"),

  // Database monitoring service
  DATABASE_MONITOR_URL: optionalUrl,
  DATABASE_HEALTH_PATH: z.string().default("/internal/health"),
  DATABASE_METRICS_PATH: z.string().default("/internal/metrics"),

  // Authentication service
  AUTH_BASE_URL: optionalUrl,
  AUTH_HEALTH_PATH: z.string().default("/internal/health"),
  AUTH_METRICS_PATH: z.string().default("/internal/metrics"),
  AUTH_LOGS_PATH: z.string().default("/internal/logs"),

  // Third-party APIs
  EXTERNAL_API_BASE_URL: optionalUrl,
  EXTERNAL_API_HEALTH_PATH: z.string().default("/health"),
  EXTERNAL_API_METRICS_PATH: z.string().default("/metrics"),

  // Git repository integration
  GIT_REPOSITORY_PATH: optionalString,
  GIT_BRANCH: z.string().default("main"),

  // CI/CD integration
  CICD_BASE_URL: optionalUrl,
  CICD_DEPLOYMENTS_PATH: z.string().default("/api/deployments"),
  CICD_API_TOKEN: optionalString
});

// Validate environment variables
const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error(
    "Invalid environment configuration:",
    parsed.error.flatten().fieldErrors
  );

  process.exit(1);
}

// Export validated configuration
export const config = parsed.data;
