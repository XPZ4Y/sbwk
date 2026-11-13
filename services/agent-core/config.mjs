// Zero-dependency config. Optionally loads a local .env (KEY=VALUE) if present.
import fs from "node:fs";

try {
  const txt = fs.readFileSync(new URL("./.env", import.meta.url), "utf8");
  for (const line of txt.split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch { /* no .env */ }

const env = process.env;
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v, d) => (v && v.trim() ? v : d);
const bool = (v, d) => (v === undefined ? d : ["true", "1", "yes", "on"].includes(String(v).toLowerCase()));

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
  AGENT_MODE: env.AGENT_MODE === "live" ? "live" : "mock",
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
  // Safety limits (onboarding Step 04). Runtime-mutable via POST /config.
  DRY_RUN: env.DRY_RUN === undefined ? true : ["true", "1", "yes", "on"].includes(String(env.DRY_RUN).toLowerCase()),
  AUTO_ROLLBACK: env.AUTO_ROLLBACK === undefined ? true : ["true", "1", "yes", "on"].includes(String(env.AUTO_ROLLBACK).toLowerCase()),
  MONITORING_ACTIVE: env.MONITORING_ACTIVE === undefined ? true : ["true", "1", "yes", "on"].includes(String(env.MONITORING_ACTIVE).toLowerCase())
};

// Runtime codebase link (onboarding Step 03): GitHub repo metadata + last commits.
// Populated by POST /config from the control plane. Never stores the access token.
config.codebase = { repoUrl: undefined, fullName: undefined, commits: [] };

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
