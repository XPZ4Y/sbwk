
import {
  ConnectorEvidence,
  HealthStatus,
  ServiceName
} from "../types";
import { IntegrationError } from "./http";

type CheckType = ConnectorEvidence["check"];

export function successResult(
  service: ServiceName,
  check: CheckType,
  data: unknown,
  durationMs: number,
  evidence: string[] = []
): ConnectorEvidence {
  const candidate = data as {
    status?: string;
    healthy?: boolean;
  } | null;

  let status: HealthStatus = "unknown";

  if (
    candidate?.status &&
    ["healthy", "degraded", "unhealthy", "unreachable"].includes(candidate.status)
  ) {
    status = candidate.status as HealthStatus;
  } else if (candidate?.healthy === true) {
    status = "healthy";
  } else if (candidate?.healthy === false) {
    status = "unhealthy";
  }

  return {
    service,
    check,
    status,
    observedAt: new Date().toISOString(),
    source: `${service}.${check}`,
    data,
    evidence,
    durationMs
  };
}

export function failureResult(
  service: ServiceName,
  check: CheckType,
  error: unknown
): ConnectorEvidence {
  const integrationError =
    error instanceof IntegrationError
      ? error
      : new IntegrationError(
          "INTERNAL_ERROR",
          "Integration check failed",
          service
        );

  const status: HealthStatus =
    integrationError.code === "NOT_CONFIGURED"
      ? "unknown"
      : "unreachable";

  return {
    service,
    check,
    status,
    observedAt: new Date().toISOString(),
    source: `${service}.${check}`,
    evidence: [],
    error: {
      code: integrationError.code,
      message: integrationError.message
    },
    durationMs: 0
  };
}
