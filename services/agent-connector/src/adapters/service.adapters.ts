import { config } from "../config";
import { ServiceName, ConnectorEvidence } from "../types";
import { getJson } from "../lib/http";
import { failureResult, successResult } from "../lib/result";
import { mockCheck } from "./mock.adapter";

type CheckName = "health" | "metrics" | "logs" | "deployments" | "recent_changes";

const serviceConfig: Record<ServiceName, {
  baseUrl?: string;
  paths: Partial<Record<CheckName, string>>;
}> = {
  server: {
    baseUrl: config.SERVER_BASE_URL,
    paths: { health: config.SERVER_HEALTH_PATH, metrics: config.SERVER_METRICS_PATH, logs: config.SERVER_LOGS_PATH }
  },
  database: {
    baseUrl: config.DATABASE_MONITOR_URL,
    paths: { health: config.DATABASE_HEALTH_PATH, metrics: config.DATABASE_METRICS_PATH }
  },
  auth: {
    baseUrl: config.AUTH_BASE_URL,
    paths: { health: config.AUTH_HEALTH_PATH, metrics: config.AUTH_METRICS_PATH, logs: config.AUTH_LOGS_PATH }
  },
  external_api: {
    baseUrl: config.EXTERNAL_API_BASE_URL,
    paths: { health: config.EXTERNAL_API_HEALTH_PATH, metrics: config.EXTERNAL_API_METRICS_PATH }
  },
  codebase: { paths: { recent_changes: "" } },
  cicd: {
    baseUrl: config.CICD_BASE_URL,
    paths: { deployments: config.CICD_DEPLOYMENTS_PATH }
  }
};

const allowedChecks: Record<ServiceName, CheckName[]> = {
  server: ["health", "metrics", "logs"],
  database: ["health", "metrics"],
  auth: ["health", "metrics", "logs"],
  external_api: ["health", "metrics"],
  codebase: ["recent_changes"],
  cicd: ["deployments"]
};

async function gitRecentChanges(): Promise<{ data: unknown; durationMs: number }> {
  const repo = config.GIT_REPOSITORY_PATH;
  if (!repo) throw new Error("GIT_REPOSITORY_PATH is not configured");

  // Only fixed, read-only git arguments are executed. No user-provided shell input.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const started = Date.now();

  const { stdout } = await execFileAsync(
    "git",
    ["log", "-5", "--date=iso-strict", "--pretty=format:%H%x09%an%x09%ad%x09%s", config.GIT_BRANCH],
    { cwd: repo, timeout: config.REQUEST_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
  );

  const commits = stdout.split("\n").filter(Boolean).map(line => {
    const [hash, author, date, message] = line.split("\t");
    return { hash, author, date, message };
  });

  return { data: { branch: config.GIT_BRANCH, commits }, durationMs: Date.now() - started };
}

export async function inspectService(service: ServiceName, check: string): Promise<ConnectorEvidence> {
  if (!allowedChecks[service].includes(check as CheckName)) {
    return failureResult(service, check, new Error("Unsupported check for service"));
  }

  if (config.CONNECTOR_MODE === "mock") return mockCheck(service, check);

  try {
    if (service === "codebase" && check === "recent_changes") {
      const result = await gitRecentChanges();
      return successResult(service, check, result.data, result.durationMs, ["Read-only Git commit history retrieved"]);
    }

    const settings = serviceConfig[service];
    const path = settings.paths[check as CheckName];
    if (path === undefined) {
      return failureResult(service, check, new Error("No endpoint configured for this check"));
    }

    const headers: Record<string, string> = {};
    if (service === "cicd" && config.CICD_API_TOKEN) {
      headers.Authorization = `Bearer ${config.CICD_API_TOKEN}`;
    }

    const result = await getJson(settings.baseUrl, path, service, headers);
    return successResult(service, check, result.data, result.durationMs);
  } catch (error) {
    return failureResult(service, check, error);
  }
}

export const serviceChecks: Record<ServiceName, CheckName[]> = allowedChecks;
