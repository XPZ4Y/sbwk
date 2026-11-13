// services/agent-core/ai-debug.mjs
// Shared helpers for the "debug JSON of the API call to the AI" requirement.
//
// Every outbound AI call (Liquid d1 triage, Groq chat completions) is logged to
// stdout as a single-line JSON object so it survives container/`docker logs`
// collection, and — when AI_DEBUG is on — a redacted copy is attached to the
// analysis so the control-plane UI can render it under "AI call debug".

const MAX_DEBUG_CHARS = 12000;

/** Never print a full credential. `liquid_abcdef123456` -> `liq…3456`. */
export function redactKey(key) {
  if (!key || typeof key !== "string") return null;
  if (key.length <= 8) return "***";
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/** Authorization header safe to log. */
export function redactHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = /authorization|api[-_]?key|cookie/i.test(k) ? `Bearer ${redactKey(String(v).replace(/^Bearer\s+/i, ""))}` : v;
  }
  return out;
}

/** Truncate an arbitrarily large payload so one log line stays readable. */
export function clamp(value, max = MAX_DEBUG_CHARS) {
  if (value === undefined) return undefined;
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) return undefined;
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} chars truncated]` : text;
}

/**
 * Structured, single-line debug log for one AI call.
 * `ok:false` logs at warn so it is impossible to miss in the console.
 */
export function logAiCall(event, fields = {}) {
  const entry = {
    level: fields.ok === false ? "warn" : "info",
    event,
    service: "agent-core",
    timestamp: new Date().toISOString(),
    provider: fields.provider,
    ok: fields.ok,
    durationMs: fields.durationMs,
    request: fields.request,
    response: fields.response,
    error: fields.error
  };
  try {
    console.log(JSON.stringify(entry));
  } catch {
    console.log(JSON.stringify({ level: "warn", event, service: "agent-core", error: "debug payload not serialisable" }));
  }
  return entry;
}

/**
 * Build the compact, redacted record stored on the analysis when AI_DEBUG=true.
 * Keeping it small matters: it is persisted with every incident.
 */
export function debugRecord({ provider, ok, durationMs, request, response, error }) {
  return {
    provider,
    ok: ok !== false,
    durationMs,
    at: new Date().toISOString(),
    request: {
      method: request?.method,
      url: request?.url,
      headers: redactHeaders(request?.headers),
      body: request?.body
    },
    // Keep the shape ({status, body}) and clamp only the body, so the UI can
    // render "HTTP 200" separately from a very long provider payload.
    response: response === undefined
      ? undefined
      : (typeof response === "object" ? { ...response, body: clamp(response.body) } : clamp(response)),
    error: error === undefined ? undefined : String(error)
  };
}
