import { config } from "../config";

export class IntegrationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly service: string
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

export async function getJson(
  baseUrl: string | undefined,
  path: string,
  service: string,
  extraHeaders: Record<string, string> = {}
): Promise<{ data: unknown; durationMs: number }> {
  if (!baseUrl) {
    throw new IntegrationError("NOT_CONFIGURED", `${service} integration URL is not configured`, service);
  }

  const url = new URL(path, baseUrl);
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", ...extraHeaders },
      signal: controller.signal
    });

    const durationMs = Date.now() - started;
    const bodyText = await response.text();

    if (!response.ok) {
      throw new IntegrationError(
        `HTTP_${response.status}`,
        `${service} returned HTTP ${response.status}`,
        service
      );
    }

    let data: unknown;
    try {
      data = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      throw new IntegrationError("INVALID_JSON", `${service} returned invalid JSON`, service);
    }

    return { data, durationMs };
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new IntegrationError("TIMEOUT", `${service} request timed out`, service);
    }
    throw new IntegrationError("CONNECTION_FAILED", `${service} could not be reached`, service);
  } finally {
    clearTimeout(timeout);
  }
}
