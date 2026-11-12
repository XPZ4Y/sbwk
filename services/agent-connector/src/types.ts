export type ServiceName = "database" | "auth" | "external_api";
export type HealthStatus = "healthy" | "degraded" | "unhealthy" | "unreachable" | "unknown";

export interface ConnectorEvidence {
  service: ServiceName;
  check: "health" | "metrics" | "logs";
  status: HealthStatus;
  observedAt: string;
  source: string;
  data?: unknown;
  evidence: string[];
  error?: { code: string; message: string };
  durationMs: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  service: ServiceName;
  inputSchema: Record<string, unknown>;
  permission: "read";
  category: "dependency";
  outputDescription: string;
}
