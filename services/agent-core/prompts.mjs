// services/agent-core/prompts.mjs
// Configurable prompt engineering for the Groq reasoner.
//
// Why this file exists: the prompt is the single biggest lever on answer
// quality, so it must be testable without editing code. Pick a built-in
// profile, or override the system prompt / user template verbatim — via env
// (`GROQ_PROMPT_PROFILE`, `GROQ_SYSTEM_PROMPT`, `GROQ_PROMPT_TEMPLATE`,
// `GROQ_TEMPERATURE`, `GROQ_MAX_TOKENS`) or at runtime through
// `POST /config` on agent-core (surfaced in the control-plane Config tab).
//
// Template variables (all optional, unknown ones render as ""):
//   {{incident}}            compact incident JSON
//   {{dependencyFindings}}  dependency evidence already gathered (read-only)
//   {{codeFindings}}        codebase matches
//   {{recentCommits}}       last commits of the linked repository
//   {{repoUrl}}             linked repository URL
//   {{recurring}}           how many times this path failed recently
//   {{liquid}}              the Liquid d1 triage decision (may be empty)
//   {{tools}}               available tool names
//   {{evidence}}            dependency + code + commits bundled together

/** The JSON contract the reasoner must return. Shared by every profile. */
export const OUTPUT_CONTRACT = [
  "Respond with ONLY a JSON object (no markdown) with keys:",
  "severity (low|medium|high|critical), summary (string),",
  "rootCause {summary, confidence 0..1}, confidence (0..1),",
  "suggestedFixes (array of {title, description, kind: config|code|dependency|investigation, file?, diff? (unified diff string)}),",
  "reasoning (string).",
  "confidence and rootCause.confidence MUST be JSON numbers between 0 and 1, not strings."
].join(" ");

const TOOL_HINT =
  "Available tools: inspect_database_health/metrics/logs, inspect_auth_health/metrics/logs, " +
  "inspect_external_api_health/metrics/logs, and search_codebase.";

export const PROMPT_PROFILES = {
  balanced: {
    label: "Balanced (default)",
    description: "Evidence-first diagnosis; up to 3 fixes, diffs only when short.",
    temperature: 0.2,
    maxTokens: 4000,
    systemPrompt: [
      "You are SBWK Agent Core, a read-only site-reliability assistant.",
      "You diagnose production incidents by calling read-only diagnostic tools.",
      "Call tools to gather evidence first. Do not guess.",
      TOOL_HINT,
      "Start by checking the dependencies most likely to be involved based on the incident.",
      "After you have enough evidence, return the final JSON diagnosis WITHOUT any tool calls.",
      "Do not invent facts about dependencies that are reported healthy.",
      "You suggest fixes but NEVER execute, deploy, restart or remediate anything.",
      OUTPUT_CONTRACT,
      "Prefer dependency root causes when a dependency is unhealthy.",
      "Return at most 3 suggestedFixes; omit diff unless it is short."
    ].join(" "),
    userPromptTemplate: [
      "Diagnose this incident.",
      "",
      "INCIDENT:",
      "{{incident}}",
      "",
      "EVIDENCE ALREADY GATHERED (read-only):",
      "{{evidence}}",
      "",
      "LIQUID ROUTER DECISION:",
      "{{liquid}}"
    ].join("\n")
  },

  concise: {
    label: "Concise",
    description: "One-sentence summary, at most 2 fixes, no diffs. Cheap and fast.",
    temperature: 0.1,
    maxTokens: 1200,
    systemPrompt: [
      "You are SBWK Agent Core, a terse site-reliability assistant.",
      TOOL_HINT,
      "Use at most two tool calls, then answer.",
      "You suggest fixes but NEVER execute, deploy, restart or remediate anything.",
      OUTPUT_CONTRACT,
      "summary must be one sentence. Return at most 2 suggestedFixes and never include diff."
    ].join(" "),
    userPromptTemplate: [
      "Incident:",
      "{{incident}}",
      "",
      "Evidence:",
      "{{evidence}}"
    ].join("\n")
  },

  diff_first: {
    label: "Diff-first",
    description: "Always proposes a concrete unified diff for the top fix.",
    temperature: 0.15,
    maxTokens: 4000,
    systemPrompt: [
      "You are SBWK Agent Core, a read-only site-reliability engineer.",
      TOOL_HINT,
      "Gather evidence with tools, then produce an actionable patch.",
      "You suggest fixes but NEVER execute, deploy, restart or remediate anything.",
      OUTPUT_CONTRACT,
      "The FIRST suggestedFix MUST include a short unified diff (--- a/path, +++ b/path, @@ hunk header) that applies to the code you inspected.",
      "Diffs must change at most ~15 lines and must be plausible for the matched file; never invent line numbers beyond the file length.",
      "Return at most 3 suggestedFixes."
    ].join(" "),
    userPromptTemplate: [
      "Produce a fix for this incident. Prefer a minimal, reviewable diff.",
      "",
      "INCIDENT:",
      "{{incident}}",
      "",
      "EVIDENCE (read-only):",
      "{{evidence}}",
      "",
      "LIQUID ROUTER DECISION:",
      "{{liquid}}"
    ].join("\n")
  },

  strict_json: {
    label: "Strict JSON",
    description: "No prose, no optional fields; for deterministic parsing.",
    temperature: 0,
    maxTokens: 2500,
    systemPrompt: [
      "You are a JSON-only incident classifier for SBWK.",
      TOOL_HINT,
      "Do not write any text outside the JSON object. Do not use markdown fences.",
      "You suggest fixes but NEVER execute, deploy, restart or remediate anything.",
      OUTPUT_CONTRACT,
      "reasoning must be a single sentence. Never include diff."
    ].join(" "),
    userPromptTemplate: [
      "{\"task\":\"diagnose\",\"incident\":{{incident}},\"dependencyFindings\":{{dependencyFindings}},\"codeFindings\":{{codeFindings}},\"recurring\":{{recurring}}}"
    ].join("\n")
  },

  sre_checklist: {
    label: "SRE checklist",
    description: "Hypothesis-driven: states what is ruled out before concluding.",
    temperature: 0.3,
    maxTokens: 4000,
    systemPrompt: [
      "You are SBWK Agent Core, a senior site-reliability engineer.",
      TOOL_HINT,
      "Work as a checklist: (1) what changed, (2) which dependency is unhealthy,",
      "(3) what the code path does, (4) what is ruled out. State the ruled-out hypotheses in `reasoning`.",
      "You suggest fixes but NEVER execute, deploy, restart or remediate anything.",
      OUTPUT_CONTRACT,
      "reasoning should read like a short SRE log with the hypotheses you ruled out and why.",
      "Return at most 3 suggestedFixes."
    ].join(" "),
    userPromptTemplate: [
      "Run the SRE checklist for this incident, then conclude.",
      "",
      "INCIDENT:",
      "{{incident}}",
      "",
      "EVIDENCE:",
      "{{evidence}}",
      "",
      "PRIOR TRIAGE:",
      "{{liquid}}"
    ].join("\n")
  }
};

export const DEFAULT_PROFILE = "balanced";
export const TOOL_NAMES = [
  "inspect_database_health", "inspect_database_metrics", "inspect_database_logs",
  "inspect_auth_health", "inspect_auth_metrics", "inspect_auth_logs",
  "inspect_external_api_health", "inspect_external_api_metrics", "inspect_external_api_logs",
  "search_codebase"
];

/** Profile catalogue for the UI (no prompts, just what you can choose). */
export function listProfiles() {
  return Object.entries(PROMPT_PROFILES).map(([id, p]) => ({
    id, label: p.label, description: p.description, temperature: p.temperature, maxTokens: p.maxTokens
  }));
}

const asNumber = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const asText = (v, fallback) => (typeof v === "string" && v.trim() ? v : fallback);

/**
 * Resolve the effective prompt settings. Precedence:
 *   explicit `cfg.llm` override > env-backed `cfg.GROQ_*` > built-in profile.
 * Never throws: an unknown profile id falls back to DEFAULT_PROFILE.
 */
export function resolvePromptSettings(cfg = {}) {
  const llm = cfg.llm || {};
  const profileId = asText(llm.profile, asText(cfg.GROQ_PROMPT_PROFILE, DEFAULT_PROFILE));
  const profile = PROMPT_PROFILES[profileId] || PROMPT_PROFILES[DEFAULT_PROFILE];

  const systemPrompt = asText(llm.systemPrompt, asText(cfg.GROQ_SYSTEM_PROMPT, profile.systemPrompt));
  const userPromptTemplate = asText(llm.userPromptTemplate, asText(cfg.GROQ_PROMPT_TEMPLATE, profile.userPromptTemplate));
  const temperature = Math.max(0, Math.min(2, asNumber(llm.temperature, asNumber(cfg.GROQ_TEMPERATURE, profile.temperature))));
  const maxTokens = Math.max(256, Math.min(16000, Math.round(asNumber(llm.maxTokens, asNumber(cfg.GROQ_MAX_TOKENS, profile.maxTokens)))));

  return {
    profile: PROMPT_PROFILES[profileId] ? profileId : DEFAULT_PROFILE,
    systemPrompt,
    userPromptTemplate,
    temperature,
    maxTokens,
    // "custom" means at least one field was overridden away from the profile.
    isCustom: systemPrompt !== profile.systemPrompt || userPromptTemplate !== profile.userPromptTemplate
  };
}

/**
 * Tiny, dependency-free `{{var}}` renderer.
 * Values may be strings or anything JSON-serialisable. Unknown/undefined -> "".
 */
export function renderTemplate(template, variables = {}) {
  return String(template ?? "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) => {
    const value = variables[key];
    if (value === undefined || value === null) return "";
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  });
}
