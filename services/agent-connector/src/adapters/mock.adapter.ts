import { z } from "zod";
import { ConnectorEvidence, ServiceName } from "../types";
import { getMockScenario } from "./mock-scenarios";
import { healthResponseSchema, logsResponseSchema, metricsResponseSchema } from "../contracts/diagnostics";

const now = () => new Date().toISOString();
const serviceIds: Record<ServiceName, string> = { database: "database", auth: "auth-service", external_api: "third-party-api" };
const health: Record<ServiceName, any> = {
  database: { service: "database", status: "healthy", checks: { connectivity: "healthy", connection_pool: "healthy" } },
  auth: { service: "auth-service", status: "healthy", checks: { token_signing: "healthy", identity_store: "healthy" } },
  external_api: { service: "third-party-api", status: "healthy", checks: { availability: "healthy", latency: "healthy" } }
};
const metrics: Record<ServiceName, Record<string, number>> = {
  database: { active_connections: 32, max_connections: 100, connection_pool_usage_percent: 32, average_query_ms: 42 },
  auth: { requests_per_second: 18, failed_logins_last_5m: 1, token_verification_latency_ms: 35, error_rate_percent: 0.1 },
  external_api: { http_status_code: 200, average_latency_ms: 180, timeout_count_last_5m: 0, error_rate_percent: 0 }
};
function validate<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`Mock ${label} response violates contract: ${result.error.message}`);
  return result.data;
}
export function mockCheck(service: ServiceName, check: string): ConnectorEvidence {
  const observedAt = now(); const scenario = getMockScenario(); let data: unknown; let status: ConnectorEvidence["status"] = "unknown"; let evidence: string[] = [];
  if (check === "health") {
    const sample = structuredClone(health[service]); sample.timestamp = observedAt;
    if (scenario === "database_failure" && service === "database") { sample.status = "unhealthy"; sample.checks.connection_pool = "unhealthy"; }
    if (scenario === "database_failure" && service === "auth") { sample.status = "degraded"; sample.checks.identity_store = "degraded"; }
    if (scenario === "external_api_failure" && service === "external_api") { sample.status = "unhealthy"; sample.checks.availability = "unhealthy"; sample.checks.latency = "unhealthy"; }
    const parsed = validate(healthResponseSchema, sample, "health"); data = parsed; status = parsed.status; evidence = [`${parsed.service} reported ${parsed.status}`];
  } else if (check === "metrics") {
    const values = { ...metrics[service] };
    if (scenario === "database_failure" && service === "database") Object.assign(values, { active_connections: 100, connection_pool_usage_percent: 100, average_query_ms: 2400 });
    if (scenario === "database_failure" && service === "auth") Object.assign(values, { token_verification_latency_ms: 950, error_rate_percent: 12.5 });
    if (scenario === "external_api_failure" && service === "external_api") Object.assign(values, { http_status_code: 503, average_latency_ms: 5000, timeout_count_last_5m: 27, error_rate_percent: 42 });
    const parsed = validate(metricsResponseSchema, { service: serviceIds[service], timestamp: observedAt, metrics: values }, "metrics"); data = parsed; evidence = [`Retrieved ${Object.keys(parsed.metrics).length} metrics from ${parsed.service}`];
  } else if (check === "logs") {
    const logs: Array<{ timestamp: string; level: "info" | "warn" | "error"; message: string; source: string }> = [{ timestamp: observedAt, level: "info", message: `${serviceIds[service]} diagnostic check completed`, source: "mock-monitor" }];
    if (scenario === "database_failure" && service === "database") logs.unshift({ timestamp: observedAt, level: "error", message: "Connection pool exhausted: 100 of 100 connections in use", source: "database-pool" }, { timestamp: observedAt, level: "error", message: "Database query timed out after 2400ms", source: "query-engine" });
    if (scenario === "database_failure" && service === "auth") logs.unshift({ timestamp: observedAt, level: "error", message: "Identity store query delayed while acquiring database connection", source: "identity-store" });
    if (scenario === "external_api_failure" && service === "external_api") logs.unshift({ timestamp: observedAt, level: "error", message: "Upstream dependency returned HTTP 503", source: "http-client" }, { timestamp: observedAt, level: "error", message: "External API request timed out", source: "http-client" });
    const parsed = validate(logsResponseSchema, { service: serviceIds[service], timestamp: observedAt, logs }, "logs"); data = parsed; evidence = [`Retrieved ${parsed.logs.length} log entries from ${parsed.service}`];
  }
  return { service, check: check as ConnectorEvidence["check"], status, observedAt, source: `mock.${service}.${check}`, data, evidence, durationMs: 5 };
}
