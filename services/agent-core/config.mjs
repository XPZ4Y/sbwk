// Zero-dependency config. Optionally loads a local .env (KEY=VALUE) if present.
import fs from "node:fs";

/**
 * Parse a .env file into key/value pairs. Handles CRLF, optional `export `
 * prefix, single/double quoted values, and inline `#` comments on unquoted values.
 */
export function parseEnvContent(txt) {
  const out = {};
  if (typeof txt !== "string" || !txt) return out;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      const quote = val[0];
      val = val.slice(1, -1);
      if (quote === '"') {
        val = val.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
    } else {
      // Strip inline comments on unquoted values (only when preceded by whitespace).
      const hashIdx = val.search(/\s+#/);
      if (hashIdx !== -1) val = val.slice(0, hashIdx).trim();
    }
    out[key] = val;
  }
  return out;
}

function loadEnvFile(url) {
  try {
    const txt = fs.readFileSync(url, "utf8");
    const parsed = parseEnvContent(txt);
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch { /* no .env */ }
}

// Skip disk .env loading under automated tests so a developer's real .env never
// leaks credentials or triggers outbound alerts during `node --test`.
if (process.env.NODE_ENV !== "test" && !process.env.NODE_TEST_CONTEXT) {
  loadEnvFile(new URL("./.env", import.meta.url));
  loadEnvFile(new URL("../../.env", import.meta.url));
}

const env = process.env;
const num = (v, d) => (v !== undefined && v !== null && String(v).trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
const clampInt = (v, d, min, max) => {
  const n = num(v, d);
  if (!Number.isFinite(n)) return d;
  return Math.max(min, Math.min(max, Math.round(n)));
};
const str = (v, d) => {
  if (v === undefined || v === null) return d;
  const trimmed = String(v).trim();
  return trimmed ? trimmed : d;
};
const bool = (v, d) => {
  if (v === undefined || v === null || String(v).trim() === "") return d;
  return ["true", "1", "yes", "on"].includes(String(v).trim().toLowerCase());
};

// JSON-from-env helper: bad JSON must not stop the service from booting.
const json = (v, d) => {
  if (!v || !String(v).trim()) return d;
  try {
    return JSON.parse(v);
  } catch {
    console.error(JSON.stringify({ level: "warn", event: "invalid_json_env", service: "agent-core", value: String(v).slice(0, 120) }));
    return d;
  }
};

export const config = {
  NODE_ENV: str(env.NODE_ENV, "development"),
  PORT: num(env.PORT, 4200),
  AGENT_CORE_TOKEN: str(env.AGENT_CORE_TOKEN, "development-only-change-this-agent-token-123456"),
  AGENT_MODE: str(env.AGENT_MODE, "mock") === "live" ? "live" : "mock",
  GROQ_API_KEY: str(env.GROQ_API_KEY, undefined),
  GROQ_MODEL: str(env.GROQ_MODEL, "openai/gpt-oss-20b"),
  GROQ_BASE_URL: str(env.GROQ_BASE_URL, "https://api.groq.com/openai/v1"),
  LLM_TIMEOUT_MS: num(env.LLM_TIMEOUT_MS, 20000),

  // --- Configurable prompt engineering (see prompts.mjs) -------------------
  // Profile id: balanced | concise | diff_first | strict_json | sre_checklist
  GROQ_PROMPT_PROFILE: str(env.GROQ_PROMPT_PROFILE, "balanced"),
  // Full overrides; when unset the selected profile's prompt is used.
  GROQ_SYSTEM_PROMPT: str(env.GROQ_SYSTEM_PROMPT, undefined),
  GROQ_PROMPT_TEMPLATE: str(env.GROQ_PROMPT_TEMPLATE, undefined),
  GROQ_TEMPERATURE: num(env.GROQ_TEMPERATURE, undefined),
  GROQ_MAX_TOKENS: num(env.GROQ_MAX_TOKENS, undefined),

  // --- Liquid AI d1 triage router ------------------------------------------
  // When unset, every incident routes straight to Groq (documented default).
  LIQUID_API_KEY: str(env.LIQUID_API_KEY, undefined),
  LIQUID_BASE_URL: str(env.LIQUID_BASE_URL, "https://api.liquid.ai"),
  LIQUID_DECISIONS_PATH: str(env.LIQUID_DECISIONS_PATH, "/decisions/v1/systemone"),
  LIQUID_MODEL: str(env.LIQUID_MODEL, "d1"),
  LIQUID_TIMEOUT_MS: num(env.LIQUID_TIMEOUT_MS, 8000),
  LIQUID_MAX_STATE_CHARS: num(env.LIQUID_MAX_STATE_CHARS, 6000),
  LIQUID_ENABLED: bool(env.LIQUID_ENABLED, true),
  LIQUID_ROUTE_POLICY: json(env.LIQUID_ROUTE_POLICY, undefined),
  LIQUID_QUESTIONS: json(env.LIQUID_QUESTIONS, undefined),

  // --- Lazy two-stage gate (see batch.mjs) ----------------------------------
  // Liquid answers ONE noul question over a log digest from the middleware.
  // Probability at/above this threshold means "worth a real LLM" → investigate.
  BATCH_LIQUID_ANOMALY_THRESHOLD: num(env.BATCH_LIQUID_ANOMALY_THRESHOLD, 0.6),
  // When Liquid cannot answer the gate: "investigate" (default, keeps signal)
  // or "skip" (accept the miss, logged loudly). Nothing is ever dropped silently.
  LIQUID_BATCH_FALLBACK: str(env.LIQUID_BATCH_FALLBACK, "investigate").toLowerCase() === "skip" ? "skip" : "investigate",
  // Hard cap on incidents accepted in one batch (middleware rings at 50).
  BATCH_MAX_INCIDENTS: num(env.BATCH_MAX_INCIDENTS, 50),

  // Attach a redacted request/response record to each analysis (rendered in the UI).
  AI_DEBUG: bool(env.AI_DEBUG, true),
  CONNECTOR_URL: str(env.CONNECTOR_URL, "http://localhost:4100"),
  CONNECTOR_API_TOKEN: str(env.CONNECTOR_API_TOKEN, "development-only-change-this-token-123456"),
  REQUEST_TIMEOUT_MS: num(env.REQUEST_TIMEOUT_MS, 5000),
  CODEBASE_PATH: str(env.CODEBASE_PATH, undefined),
  CODEBASE_MAX_FILES: num(env.CODEBASE_MAX_FILES, 400),
  CODEBASE_MAX_FINDINGS: num(env.CODEBASE_MAX_FINDINGS, 6),
  MAX_CONTEXT_INCIDENTS: num(env.MAX_CONTEXT_INCIDENTS, 200),
  DATA_DIR: str(env.DATA_DIR, undefined),
  ESCALATION_CONFIDENCE_THRESHOLD: num(env.ESCALATION_CONFIDENCE_THRESHOLD, 0.5),
  NOTIFICATION_WEBHOOK_URL: str(env.NOTIFICATION_WEBHOOK_URL, undefined),
  // --- Resend.com email notifications (zero-dependency via fetch) ----------
  RESEND_API_KEY: str(env.RESEND_API_KEY, undefined),
  DEVELOPER_EMAIL: str(env.DEVELOPER_EMAIL, undefined),
  RESEND_FROM_EMAIL: str(env.RESEND_FROM_EMAIL, "onboarding@resend.dev"),
  RESEND_NOTIFY_ALL_INCIDENTS: bool(env.RESEND_NOTIFY_ALL_INCIDENTS, true),
  RESEND_API_BASE_URL: str(env.RESEND_API_BASE_URL, "https://api.resend.com"),
  RESEND_TIMEOUT_MS: clampInt(env.RESEND_TIMEOUT_MS, 10000, 1000, 60000),
  RESEND_MAX_RETRIES: clampInt(env.RESEND_MAX_RETRIES, 2, 0, 5),
  // Safety limits (onboarding Step 04). Runtime-mutable via POST /config.
  DRY_RUN: bool(env.DRY_RUN, true),
  AUTO_ROLLBACK: bool(env.AUTO_ROLLBACK, true),
  MONITORING_ACTIVE: bool(env.MONITORING_ACTIVE, true)
};

// Runtime codebase link (onboarding Step 03): GitHub repo metadata + last commits.
// Populated by POST /config from the control plane. Never stores the access token.
config.codebase = { repoUrl: undefined, fullName: undefined, branch: undefined, commits: [], diffs: [] };

// Runtime prompt overrides for the Groq reasoner (Config tab -> "AI"). Any key
// left out falls back to GROQ_PROMPT_PROFILE / env. See prompts.mjs.
//   { profile, systemPrompt, userPromptTemplate, temperature, maxTokens }
config.llm = {};

export const investigateServices = str(env.INVESTIGATE_SERVICES, "database,auth,external_api")
  .split(",").map(s => s.trim())
  .filter(s => ["database", "auth", "external_api"].includes(s));

if (config.NODE_ENV === "production" && config.AGENT_CORE_TOKEN.startsWith("development-only")) {
  console.error("Set a unique AGENT_CORE_TOKEN before production.");
  process.exit(1);
}
