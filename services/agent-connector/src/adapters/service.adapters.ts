
import { config } from "../config";
import {
  ConnectorEvidence,
  ServiceName
} from "../types";

import { getJson } from "../lib/http";
import { failureResult, successResult } from "../lib/result";
import { mockCheck } from "./mock.adapter";

import {
  healthResponseSchema,
  metricsResponseSchema,
  logsResponseSchema
} from "../contracts/diagnostics";

type CheckType = ConnectorEvidence["check"];

const isCheckType = (check: string): check is CheckType => {
  return (
    check === "health" ||
    check === "metrics" ||
    check === "logs"
  );
};

const settings: Record<
  ServiceName,
  {
    baseUrl?: string;
    token?: string;
    paths: Record<CheckType, string>;
  }
> = {
  database: {
    baseUrl: config.DATABASE_BASE_URL,
    token: config.DATABASE_API_TOKEN,
    paths: {
      health: config.DATABASE_HEALTH_PATH,
      metrics: config.DATABASE_METRICS_PATH,
      logs: config.DATABASE_LOGS_PATH
    }
  },

  auth: {
    baseUrl: config.AUTH_BASE_URL,
    token: config.AUTH_API_TOKEN,
    paths: {
      health: config.AUTH_HEALTH_PATH,
      metrics: config.AUTH_METRICS_PATH,
      logs: config.AUTH_LOGS_PATH
    }
  },

  external_api: {
    baseUrl: config.EXTERNAL_API_BASE_URL,
    token: config.EXTERNAL_API_TOKEN,
    paths: {
      health: config.EXTERNAL_API_HEALTH_PATH,
      metrics: config.EXTERNAL_API_METRICS_PATH,
      logs: config.EXTERNAL_API_LOGS_PATH
    }
  }
};

export const serviceChecks: Record<ServiceName, CheckType[]> = {
  database: ["health", "metrics", "logs"],
  auth: ["health", "metrics", "logs"],
  external_api: ["health", "metrics", "logs"]
};

export async function inspectService(
  service: ServiceName,
  check: string
): Promise<ConnectorEvidence> {

  // Validate the requested diagnostic check.
  if (!isCheckType(check)) {
    return failureResult(
      service,
      "health",
      new Error("Unsupported diagnostic check")
    );
  }

  if (!serviceChecks[service].includes(check)) {
    return failureResult(
      service,
      check,
      new Error("Unsupported diagnostic check")
    );
  }

  // Return mock data when mock mode is enabled.
  if (config.CONNECTOR_MODE === "mock") {
    return mockCheck(service, check);
  }

  const target = settings[service];

  if (!target.baseUrl) {
    return failureResult(
      service,
      check,
      new Error(
        `${service.toUpperCase()}_BASE_URL is not configured`
      )
    );
  }

  try {
    const headers: Record<string, string> = {};

    if (target.token) {
      headers.Authorization = `Bearer ${target.token}`;
    }

    const result = await getJson(
      target.baseUrl,
      target.paths[check],
      service,
      headers
    );

    const schema =
      check === "health"
        ? healthResponseSchema
        : check === "metrics"
          ? metricsResponseSchema
          : logsResponseSchema;

    const parsed = schema.safeParse(result.data);

    if (!parsed.success) {
      throw new Error(
        `${service} ${check} response violates the diagnostic contract: ${parsed.error.message}`
      );
    }

    return successResult(
      service,
      check,
      parsed.data,
      result.durationMs
    );

  } catch (error) {
    return failureResult(service, check, error);
  }
}
