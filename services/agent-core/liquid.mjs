// services/agent-core/liquid.mjs
// ---------------------------------------------------------------------------
// Liquid AI (d1 decision model) — the fast triage gate that runs BEFORE any
// generative reasoning.
//
// Pipeline position:
//
//   incident ──▶ evidence (connector + codebase) ──▶ LIQUID TRIAGE ──┬─▶ "engineer"  → wake a human, skip the LLM
//                                                                    └─▶ "groq"      → Groq reasons & proposes fixes
//
// d1 is a decision model: it takes a shared `state` (all our context) plus a
// map of typed `questions` (choice / noul / score) and returns calibrated
// probabilities — no prose, no tokens generated. That makes it a cheap, ~200ms
// router. See https://docs.liquid.ai/api/reference/decision-models/make-decisions
//
// Behaviour when the API is not configured or not reachable:
//   * no LIQUID_API_KEY  → default route is "groq" (documented fallback).
//   * key set but call fails → route "groq" + a hard warning the UI renders in red.
// The reasoner therefore never depends on Liquid being up.

import { logAiCall, debugRecord } from "./ai-debug.mjs";

const LIQUID_PATH = "/decisions/v1/systemone";

/** Questions sent to d1. Mirrors the documented example; overridable via config. */
export const DEFAULT_QUESTIONS = {
  department: {
    type: "choice",
    instructions: "Which team should handle this?",
    criteria: {
      billing: "Payments, invoicing, refunds",
      technical: "Bugs, outages, integrations",
      sales: "Pricing, upgrades, new accounts"
    }
  },
  is_urgent: {
    type: "noul",
    instructions: "Does this convey urgency?"
  },
  frustration: {
    type: "score",
    instructions: "How frustrated is the customer?",
    criteria: ["Calm", "Frustrated", "Very angry"]
  }
};

/**
 * How d1's answers become a routing decision. Pure data, so it can be tuned
 * from the UI/env without touching code.
 */
export const DEFAULT_ROUTE_POLICY = {
  // noul probability above which the incident counts as urgent.
  urgentThreshold: 0.6,
  // score at/above which the reporter counts as "Very angry" (0=Calm, 1=Frustrated, 2=Very angry).
  frustrationThreshold: 1.5,
  // Departments that are never handled by the AI reasoner.
  engineerDepartments: ["billing", "sales"],
  // Urgent AND angry => a human should look, whatever the department says.
  engineerOnUrgentFrustration: true,
  // If d1 cannot pick a department confidently, prefer a human.
  engineerOnUnsureDepartment: false,
  choiceConfidenceFloor: 0.2,
  // Where to send anything the policy does not explicitly claim.
  default: "groq"
};

export const ROUTES = { ENGINEER: "engineer", GROQ: "groq" };

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max)}…[truncated ${text.length - max} chars]` : text);

/**
 * Flatten everything the pipeline already knows into the `state` string d1
 * sees. Deterministic and human-readable — when a routing decision looks
 * wrong, this string is the first thing to read.
 */
export function buildLiquidState(input, maxChars = 6000) {
  const { incident = {}, dependency = {}, codeFindings = [], recurring = 0, recentCommits = [], repoUrl, dependencyFindings } = input;
  const lines = [];

  lines.push("INCIDENT");
  lines.push(`method: ${incident.method || "?"}`);
  lines.push(`path: ${incident.path || "?"}`);
  lines.push(`status: ${incident.statusCode ?? "?"}`);
  lines.push(`category: ${incident.category || "?"}`);
  lines.push(`reason: ${incident.reason || "?"}`);
  if (incident.durationMs !== undefined) lines.push(`durationMs: ${Math.round(incident.durationMs)}`);
  lines.push(`prior occurrences on this path: ${recurring}`);
  if (incident.error) lines.push(`error: ${String(incident.error).slice(0, 400)}`);
  if (incident.responseSample) lines.push(`response sample: ${String(incident.responseSample).slice(0, 600)}`);

  const findings = dependencyFindings || summarizeDependency(dependency);
  lines.push("", "DEPENDENCIES");
  if (!findings.length) lines.push("no dependency evidence");
  else {
    for (const f of findings) {
      const signals = (f.signals || []).slice(0, 4).join("; ");
      lines.push(`- ${f.service}: ${f.status}${signals ? ` (${signals})` : ""}`);
    }
    if (dependency.error) lines.push(`- connector error: ${dependency.error}`);
  }

  lines.push("", "CODEBASE MATCHES");
  if (!codeFindings.length) lines.push("none");
  else {
    for (const c of codeFindings.slice(0, 4)) {
      lines.push(`- ${c.file}${c.line ? `:${c.line}` : ""} — ${String(c.reason || c.snippet || "").slice(0, 220)}`);
    }
  }

  if (recentCommits.length) {
    lines.push("", `RECENT COMMITS${repoUrl ? ` (${repoUrl})` : ""}`);
    for (const c of recentCommits.slice(0, 5)) {
      lines.push(`- ${String(c.sha || "").slice(0, 7)} ${String(c.message || "").split("\n")[0].slice(0, 120)}`);
    }
  }

  return truncate(lines.join("\n"), maxChars);
}

function summarizeDependency(dependency = {}) {
  const byService = new Map();
  for (const e of dependency.results || []) {
    const prev = byService.get(e.service);
    if (!prev) byService.set(e.service, { service: e.service, status: e.status, signals: [] });
    else if (e.status && e.status !== "healthy") byService.set(e.service, { ...prev, status: e.status });
  }
  return [...byService.values()];
}

/** Normalise d1's `answers` map into the three values the policy uses. */
export function extractDecision(answers = {}) {
  const dept = answers.department || {};
  const urgent = answers.is_urgent || {};
  const frustration = answers.frustration || {};

  const frustrationScore = Number.isFinite(Number(frustration.score)) ? Number(frustration.score) : null;
  const legend = frustration.legend && typeof frustration.legend === "object" ? frustration.legend : null;
  const labelFromLegend = frustrationScore !== null && legend
    ? legend[String(Math.round(frustrationScore))]
    : undefined;

  return {
    department: dept.choice || null,
    departmentConfidence: Number.isFinite(Number(dept.confidence)) ? Number(dept.confidence) : null,
    departmentProbabilities: dept.probabilities || null,
    urgencyProbability: Number.isFinite(Number(urgent.noul)) ? Number(urgent.noul) : null,
    frustrationScore,
    frustrationLabel: labelFromLegend || null,
    frustrationConfidence: Number.isFinite(Number(frustration.confidence)) ? Number(frustration.confidence) : null,
    raw: answers
  };
}

/**
 * Pure policy: d1 answers in, route out. Kept separate from the network call so
 * it is trivially unit-testable and reviewable.
 */
export function routeFromDecision(decision = {}, policy = DEFAULT_ROUTE_POLICY) {
  const p = { ...DEFAULT_ROUTE_POLICY, ...(policy || {}) };
  const reasons = [];
  const dept = decision.department ? String(decision.department).toLowerCase() : null;
  const urgent = decision.urgencyProbability !== null && decision.urgencyProbability !== undefined
    ? decision.urgencyProbability >= p.urgentThreshold
    : null;
  const veryAngry = decision.frustrationScore !== null && decision.frustrationScore !== undefined
    ? decision.frustrationScore >= p.frustrationThreshold
    : null;

  const departmentLine = dept
    ? `department=${dept}${decision.departmentConfidence !== null ? ` (confidence ${decision.departmentConfidence})` : ""}`
    : "department=unknown";
  const urgencyLine = urgent === null ? "urgency=unknown" : `urgency=${urgent ? "urgent" : "not urgent"} (${decision.urgencyProbability})`;
  const frustrationLine = veryAngry === null ? "frustration=unknown" : `frustration=${veryAngry ? "very angry" : "manageable"} (${decision.frustrationScore})`;
  const evidenceLine = `${departmentLine}; ${urgencyLine}; ${frustrationLine}`;

  if (dept && (p.engineerDepartments || []).map(d => d.toLowerCase()).includes(dept)) {
    reasons.push(`Liquid d1: the ${dept} team owns this — not a code-diagnosis problem`);
    return { route: ROUTES.ENGINEER, reasons, evidence: evidenceLine };
  }

  if (p.engineerOnUrgentFrustration && urgent === true && veryAngry === true) {
    reasons.push("Liquid d1: urgent and the reporter is very frustrated — a human should respond");
    return { route: ROUTES.ENGINEER, reasons, evidence: evidenceLine };
  }

  if (
    p.engineerOnUnsureDepartment &&
    decision.departmentConfidence !== null && decision.departmentConfidence !== undefined &&
    decision.departmentConfidence < p.choiceConfidenceFloor
  ) {
    reasons.push(`Liquid d1: department unresolved (confidence ${decision.departmentConfidence} < ${p.choiceConfidenceFloor})`);
    return { route: ROUTES.ENGINEER, reasons, evidence: evidenceLine };
  }

  reasons.push(`Liquid d1: technical diagnosis is appropriate (${evidenceLine})`);
  return { route: p.default === ROUTES.ENGINEER ? ROUTES.ENGINEER : ROUTES.GROQ, reasons, evidence: evidenceLine };
}

const warn = (severity, message, detail) => ({ severity, message, ...(detail ? { detail } : {}) });

/**
 * Call Liquid d1 and turn the answers into a route. NEVER throws and never
 * blocks the pipeline: any failure degrades to the Groq path with a warning.
 *
 * @param {object} input  { incident, dependency, codeFindings, recurring, recentCommits, repoUrl }
 * @param {object} cfg    agent-core config
 * @param {object} deps   { fetchImpl, now }
 * @returns {Promise<object>} triage record (see `shape` below)
 */
export async function liquidTriage(input, cfg = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const started = deps.now ? deps.now() : Date.now();
  const base = {
    provider: "liquid",
    model: cfg.LIQUID_MODEL || "d1",
    route: ROUTES.GROQ,
    decision: null,
    reasons: [],
    warnings: [],
    latencyMs: 0
  };

  const apiKey = cfg.LIQUID_API_KEY;
  const configured = Boolean(apiKey) && cfg.LIQUID_ENABLED !== false;

  if (!configured) {
    return {
      ...base,
      ok: true,
      status: apiKey ? "disabled" : "not_configured",
      skipped: true,
      warnings: [warn("notice", apiKey
        ? "Liquid AI routing is disabled (LIQUID_ENABLED=false) — using Groq AI."
        : "Liquid AI is not configured (LIQUID_API_KEY unset) — defaulting to Groq AI.")],
      reasons: ["no Liquid triage — default route is Groq AI"]
    };
  }

  const url = `${String(cfg.LIQUID_BASE_URL || "https://api.liquid.ai").replace(/\/$/, "")}${cfg.LIQUID_DECISIONS_PATH || LIQUID_PATH}`;
  const body = {
    model: cfg.LIQUID_MODEL || "d1",
    state: buildLiquidState(input, cfg.LIQUID_MAX_STATE_CHARS || 6000),
    questions: cfg.LIQUID_QUESTIONS || DEFAULT_QUESTIONS
  };
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  const timeoutMs = cfg.LIQUID_TIMEOUT_MS || 8000;

  // ── the actual network attempt: every branch returns a plain result ──────
  async function attempt() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let httpStatus = 0;
    let rawText = "";

    try {
      const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
      httpStatus = res.status;
      rawText = await res.text();

      if (!res.ok) {
        const message = `Liquid AI request failed (HTTP ${httpStatus}) — falling back to Groq AI.`;
        return {
          ...base, ok: false, status: "request_failed", httpStatus, rawResponse: rawText,
          warnings: [warn("error", message, truncate(rawText, 600))],
          reasons: [message], error: truncate(rawText, 600)
        };
      }

      let json;
      try {
        json = JSON.parse(rawText);
      } catch {
        const message = "Liquid AI returned a non-JSON body — falling back to Groq AI.";
        return {
          ...base, ok: false, status: "invalid_response", httpStatus, rawResponse: rawText,
          warnings: [warn("error", message, truncate(rawText, 600))],
          reasons: [message], error: truncate(rawText, 600)
        };
      }

      const answers = json.answers || json.decisions || json.results || null;
      if (!answers || typeof answers !== "object") {
        const message = "Liquid AI response had no `answers` — falling back to Groq AI.";
        return {
          ...base, ok: false, status: "no_answers", httpStatus, rawResponse: json,
          warnings: [warn("error", message, truncate(json, 600))],
          reasons: [message], error: "missing answers"
        };
      }

      const decision = extractDecision(answers);
      const routed = routeFromDecision(decision, cfg.LIQUID_ROUTE_POLICY);
      return {
        ...base,
        ok: true, status: "routed", httpStatus, rawResponse: json,
        route: routed.route, decision, reasons: routed.reasons, evidence: routed.evidence,
        usage: json.usage, raw: truncate(json, 4000)
      };
    } catch (e) {
      const aborted = e?.name === "AbortError";
      const message = aborted
        ? `Liquid AI timed out after ${timeoutMs}ms — falling back to Groq AI.`
        : `Liquid AI is unreachable (${e?.message || "network error"}) — falling back to Groq AI.`;
      return {
        ...base, ok: false, status: aborted ? "timeout" : "unreachable", httpStatus, rawResponse: rawText || undefined,
        warnings: [warn("error", message)], reasons: [message], error: String(e?.message || e)
      };
    } finally {
      clearTimeout(timer);
    }
  }

  const result = await attempt();
  result.latencyMs = (deps.now ? deps.now() : Date.now()) - started;

  // ── debug JSON of the API call (console.log + optional analysis record) ──
  const record = debugRecord({
    provider: "liquid",
    ok: result.ok !== false,
    durationMs: result.latencyMs,
    request: { method: "POST", url, headers, body },
    response: { status: result.httpStatus || 0, body: result.rawResponse },
    error: result.error
  });
  logAiCall("liquid_ai_call", {
    provider: "liquid",
    ok: result.ok !== false,
    durationMs: result.latencyMs,
    request: record.request,
    response: record.response
  });
  if (cfg.AI_DEBUG) result.aiDebug = [record];
  return result;
}
