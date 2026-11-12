import { ServiceName, ToolDefinition } from "../types";
import { serviceChecks } from "../adapters/service.adapters";

const descriptions: Record<string, string> = {
  "server.health": "Check whether the application server is healthy.",
  "server.metrics": "Retrieve server CPU, memory, latency and error metrics.",
  "server.logs": "Retrieve recent application server logs.",
  "database.health": "Check database connectivity and health.",
  "database.metrics": "Retrieve database connection and query metrics.",
  "auth.health": "Check authentication service health.",
  "auth.metrics": "Retrieve authentication failure and latency metrics.",
  "auth.logs": "Retrieve recent authentication service logs.",
  "external_api.health": "Check external dependency availability.",
  "external_api.metrics": "Retrieve external dependency latency and failure metrics.",
  "codebase.recent_changes": "Retrieve recent Git commit metadata using read-only Git commands.",
  "cicd.deployments": "Retrieve recent deployment information from the configured CI/CD endpoint."
};

export const toolDefinitions: ToolDefinition[] = Object.entries(serviceChecks).flatMap(([service, checks]) =>
  checks.map(check => ({
    name: `inspect_${service}_${check}`,
    description: descriptions[`${service}.${check}`] ?? `Inspect ${service} ${check}.`,
    service: service as ServiceName,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    permission: "read" as const
  }))
);
