import { ServiceName } from "../types";
import { ConnectorEvidence } from "../types";

const samples: Record<ServiceName, { status: ConnectorEvidence["status"]; data: unknown; evidence: string[] }> = {
  server: {
    status: "healthy",
    data: { cpuPercent: 24, memoryPercent: 51, errorRatePercent: 0.4, latencyMs: 82 },
    evidence: ["Server health endpoint is responding", "CPU and memory are within configured demo thresholds"]
  },
  database: {
    status: "degraded",
    data: { connected: true, activeConnections: 95, maxConnections: 100, averageQueryMs: 240 },
    evidence: ["Database is reachable", "Connection pool is at 95% utilization"]
  },
  auth: {
    status: "healthy",
    data: { failedLoginsLast5m: 2, tokenVerificationLatencyMs: 110 },
    evidence: ["Authentication health check succeeded"]
  },
  external_api: {
    status: "degraded",
    data: { httpStatus: 200, latencyMs: 1250, timeoutCountLast5m: 3 },
    evidence: ["External dependency is responding slowly"]
  },
  codebase: {
    status: "healthy",
    data: { branch: "main", latestCommit: "demo-a81f20c", message: "Update database connection handling", changedFiles: ["src/database.ts", "src/config.ts"] },
    evidence: ["Latest commit metadata is available"]
  },
  cicd: {
    status: "healthy",
    data: { deploymentId: "demo-deploy-102", version: "v1.2.0", previousVersion: "v1.1.0", status: "success", deployedAt: new Date(Date.now() - 5 * 60_000).toISOString() },
    evidence: ["Latest deployment completed successfully", "A previous release is recorded"]
  }
};

export function mockCheck(service: ServiceName, check: string): ConnectorEvidence {
  const sample = samples[service];
  return {
    service,
    check,
    status: sample.status,
    observedAt: new Date().toISOString(),
    source: `mock.${service}.${check}`,
    data: sample.data,
    evidence: sample.evidence,
    durationMs: Math.floor(Math.random() * 25) + 5
  };
}
