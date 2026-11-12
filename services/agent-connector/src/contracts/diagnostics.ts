import { z } from "zod";

export const serviceIdSchema = z.enum([
  "api-server",
  "database-monitor",
  "auth-service",
  "external-api"
]);

export const serviceHealthStatusSchema = z.enum(["healthy", "degraded", "unhealthy"]);

export const healthResponseSchema = z.object({
  service: z.string().min(1),
  status: serviceHealthStatusSchema,
  timestamp: z.string().datetime({ offset: true }),
  checks: z.record(z.enum(["healthy", "degraded", "unhealthy"])).optional()
}).strict();

export const metricsResponseSchema = z.object({
  service: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
  metrics: z.record(z.number().finite())
}).strict();

export const logEntrySchema = z.object({
  timestamp: z.string().datetime({ offset: true }),
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string().min(1),
  source: z.string().min(1).optional()
}).strict();

export const logsResponseSchema = z.object({
  service: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
  logs: z.array(logEntrySchema)
}).strict();

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type MetricsResponse = z.infer<typeof metricsResponseSchema>;
export type LogsResponse = z.infer<typeof logsResponseSchema>;
