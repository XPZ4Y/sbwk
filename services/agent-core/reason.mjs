// services/agent-core/reason.mjs
// Reasoning: dependency findings + deterministic heuristic + optional Groq LLM with tool calling.
import { config as defaultConfig } from "./config.mjs";
import { inspectCodebase } from "./codebase.mjs";
import { resolvePromptSettings, renderTemplate, TOOL_NAMES } from "./prompts.mjs";
import { logAiCall, debugRecord } from "./ai-debug.mjs";

const log = (level, event, fields = {}) =>
  console.log(JSON.stringify({ level, event, service: "agent-core", timestamp: new Date().toISOString(), ...fields }));

const STATUS_RANK = { healthy: 0, unknown: 1, degraded: 2, unhealthy: 3, unreachable: 4 };
const worst = (a, b) => (STATUS_RANK[a] >= STATUS_RANK[b] ? a : b);

function signalsFromEvidence(e) {
  const signals = [];
  const data = e.data || {};
  if (e.error) signals.push(`${e.check} check failed: ${e.error.code} ${e.error.message}`);
  if (e.check === "health" && data.checks) for (const [name, status] of Object.entries(data.checks)) if (status !== "healthy") signals.push(`${name}: ${status}`);
  if (e.check === "metrics" && data.metrics) {
    const m = data.metrics;
    if (m.connection_pool_usage_percent >= 90) signals.push(`connection pool ${m.connection_pool_usage_percent}% used`);
    if (m.error_rate_percent > 5) signals.push(`error rate ${m.error_rate_percent}%`);
    if (m.average_latency_ms >= 1000) signals.push(`avg latency ${m.average_latency_ms}ms`);
    if (m.average_query_ms >= 1000) signals.push(`avg query ${m.average_query_ms}ms`);
    if (m.http_status_code >= 500) signals.push(`upstream HTTP ${m.http_status_code}`);
    if (m.timeout_count_last_5m > 0) signals.push(`${m.timeout_count_last_5m} timeouts in 5m`);
  }
  if (e.check === "logs" && Array.isArray(data.logs)) for (const log of data.logs.filter(l => l.level === "error").slice(0, 2)) signals.push(`log: ${log.message}`);
  return signals;
}

export function deriveDependencyFindings(investigation) {
  const byService = new Map();
  for (const e of investigation.results) {
    const existing = byService.get(e.service) || { service: e.service, status: "healthy", signals: [] };
    existing.status = worst(existing.status, e.status);
    existing.signals.push(...signalsFromEvidence(e));
    byService.set(e.service, existing);
  }
  return [...byService.values()].map(f => ({ ...f, signals: [...new Set(f.signals)].slice(0, 8) }));
}

export const hasUnreachableDependency = findings => findings.some(f => f.status === "unreachable");
export const unhealthyServices = findings => findings.filter(f => ["unhealthy", "unreachable", "degraded"].includes(f.status));

const fix = (title, description, kind, file, diff) => ({ title, description, kind, file, ...(diff ? { diff } : {}) });

export function heuristicReason(input) {
  const { incident, dependency, codeFindings, recurring, recentCommits = [], repoUrl } = input;
  const findings = deriveDependencyFindings(dependency);
  const primary = unhealthyServices(findings)[0];
  let severity = "medium", summary, rootCause, confidence, fixes;
  const targetFile = codeFindings[0]?.file || "server.mjs";
  const narrative = [`Incident: ${incident.method} ${incident.path} -> HTTP ${incident.statusCode} (${incident.category}).`];
  if (dependency.error) narrative.push(`Agent Connector was not fully reachable: ${dependency.error}.`);

  if (primary) {
    const svc = primary.service;
    narrative.push(`Dependency ${svc} is ${primary.status}. Signals: ${primary.signals.join("; ") || "none"}.`);
    if (svc === "database") {
      severity = "high";
      summary = `Request failed because the database dependency is ${primary.status}.`;
      rootCause = "Database degradation (connection-pool exhaustion, slow queries or connectivity) is causing the application request to fail.";
      confidence = primary.status === "unhealthy" ? 0.82 : 0.65;
      fixes = [
        fix(
          "Add connection-pool guard and fallback timeout",
          "Wrap database queries with a pool check and bounded timeout so exhausted pools fail fast with HTTP 503 Retry-After.",
          "code",
          targetFile,
          `--- a/${targetFile}\n+++ b/${targetFile}\n@@ -14,5 +14,8 @@\n function getUsersFromDatabase() {\n   if (failMode === "database") {\n-    throw new Error("Database error: connection pool exhausted (100/100 connections in use)");\n+    const err = new Error("Database temporarily unavailable: pool exhausted");\n+    err.statusCode = 503;\n+    throw err;\n   }\n   return users;\n }`
        ),
        fix("Verify database connectivity and pool", "Check the database is reachable and the connection pool is not exhausted; raise pool size or fix leaked connections.", "dependency"),
        fix("Inspect slow queries", "Review the slowest queries and add indexes or pagination where average query time is high.", "dependency")
      ];
    } else if (svc === "external_api") {
      severity = "high";
      summary = `Request failed because a third-party API dependency is ${primary.status}.`;
      rootCause = "An upstream third-party API is returning errors or timing out, propagating failure to this request.";
      confidence = primary.status === "unhealthy" ? 0.78 : 0.6;
      fixes = [
        fix(
          "Add a circuit breaker and cached fallback",
          "Stop hammering a failing upstream; serve a degraded/cached response while the third-party provider recovers.",
          "code",
          targetFile,
          `--- a/${targetFile}\n+++ b/${targetFile}\n@@ -22,6 +22,6 @@\n function callExternalApi() {\n   if (failMode === "external") {\n-    const err = new Error("Upstream third-party API returned HTTP 503");\n-    err.statusCode = 503;\n-    throw err;\n+    return { ok: false, degraded: true, provider: "third-party-api-cache" };\n   }\n   return { ok: true, provider: "third-party-api" };\n }`
        ),
        fix("Tune client timeouts and retries", "Set explicit timeouts and bounded retries with jitter on the third-party client.", "config"),
        fix("Confirm provider status", "Check the provider's status page and your API credentials/quota.", "investigation")
      ];
    } else {
      severity = "high";
      summary = `Request failed because the authentication dependency is ${primary.status}.`;
      rootCause = "Authentication service degradation (token signing or identity-store access) is causing failures.";
      confidence = primary.status === "unhealthy" ? 0.72 : 0.58;
      fixes = [
        fix("Verify auth service health", "Check token-signing keys and identity-store connectivity on the auth service.", "dependency"),
        fix(
          "Handle auth failures gracefully",
          "Return a clear 503 with Retry-After and avoid cascading unhandled 500s when auth is degraded.",
          "code",
          targetFile,
          `--- a/${targetFile}\n+++ b/${targetFile}\n@@ -50,3 +50,4 @@\n   } catch (err) {\n+    res.setHeader("Retry-After", "5");\n     return json(res, err.statusCode || 500, { error: err.message });\n   }`
        )
      ];
    }
  } else if (incident.category === "upstream_unreachable" || incident.category === "timeout") {
    severity = "high";
    summary = "The application Server itself was unreachable or timed out.";
    rootCause = "The Server process is down, crashed, or overloaded (no dependency failure was detected).";
    confidence = 0.7;
    fixes = [
      fix("Check Server process and health", "Confirm the Server is running and its /health endpoint responds; inspect restart/crash loops.", "investigation"),
      fix("Review resource saturation", "Check CPU/memory and consider scaling or a readiness probe.", "config")
    ];
    narrative.push("No dependency failure detected; the Server endpoint did not respond.");
  } else if (incident.category === "client_error") {
    severity = "low";
    summary = `Client error HTTP ${incident.statusCode} on ${incident.path}.`;
    rootCause = "The requested route or resource does not exist or the request was malformed (e.g. missing route registration or wrong path).";
    confidence = 0.6;
    fixes = [
      fix(
        "Verify route registration",
        `Confirm ${incident.path} is registered and the HTTP method matches.`,
        "code",
        targetFile,
        `--- a/${targetFile}\n+++ b/${targetFile}\n@@ -60,2 +60,3 @@\n     if (p === "/external") return json(res, 200, callExternalApi());\n+    if (p === "${incident.path}") return json(res, 200, { ok: true });\n     return json(res, 404, { error: "Not Found", path: p });`
      ),
      fix("Check client request", "Validate the client is calling the correct path and parameters.", "investigation")
    ];
    narrative.push("No dependency failure detected; this is a client-side/routing error.");
  } else if (incident.category === "slow_response") {
    severity = "medium";
    summary = `Slow response on ${incident.path} (${Math.round(incident.durationMs)}ms).`;
    rootCause = "The request exceeded the latency threshold — likely a performance regression, an unindexed query, or downstream latency.";
    confidence = 0.5;
    fixes = [
      fix("Profile the slow endpoint", "Trace the request to find the slow span (query, external call, or CPU).", "investigation", targetFile),
      fix(
        "Bound handler execution time",
        "Enforce a strict request timeout budget or cache expensive reads on this route.",
        "code",
        targetFile,
        `--- a/${targetFile}\n+++ b/${targetFile}\n@@ -52,4 +52,4 @@\n     if (delayMatch) {\n-      const seconds = Math.min(Number(delayMatch[1]), 10);\n+      const seconds = Math.min(Number(delayMatch[1]), 1.5); // enforce SLA budget\n       await new Promise(r => setTimeout(r, seconds * 1000));`
      )
    ];
    narrative.push("No dependency outage detected; the response was slower than the configured threshold.");
  } else if (codeFindings.length > 0) {
    severity = "medium";
    summary = `Application error on ${incident.path}; relevant code located.`;
    rootCause = `An unhandled error in the application code path (see ${codeFindings[0].file}) is the most likely cause.`;
    confidence = 0.55;
    fixes = [
      fix(
        "Add structured error handling around the failing path",
        "Inspect the matched handler and add validation / try-catch with a meaningful error response.",
        "code",
        codeFindings[0].file,
        `--- a/${codeFindings[0].file}\n+++ b/${codeFindings[0].file}\n@@ -${codeFindings[0].line},3 +${codeFindings[0].line},5 @@\n // Matched snippet around line ${codeFindings[0].line}:\n+// Suggestion: guard upstream/state errors with explicit status code & fallback\n+try {\n ${codeFindings[0].snippet.split("\n")[0] || ""}\n+} catch (e) { return json(res, 503, { error: e.message, degraded: true }); }`
      ),
      fix("Reproduce with the captured request", "Use the incident request and response sample to reproduce locally.", "investigation")
    ];
    narrative.push(`Dependencies look healthy; matched ${codeFindings.length} relevant code location(s).`);
  } else {
    severity = "medium";
    summary = `Unclassified HTTP ${incident.statusCode} on ${incident.path}.`;
    rootCause = "Insufficient evidence to determine a root cause automatically.";
    confidence = 0.3;
    fixes = [
      fix("Gather more evidence", "Enable richer application logs/tracing for this route and re-run the request.", "investigation"),
      fix("Manual inspection", "An engineer should review the request path and recent deployments.", "investigation")
    ];
    narrative.push("No dependency failure and no relevant code found; evidence is insufficient.");
  }

  // Correlate the failing request with the last commits of the linked repository (if configured).
  if (recentCommits.length) {
    const pathWords = incident.path.split("/").map(s => s.replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase()).filter(s => s.length >= 3 && !/^\d+$/.test(s));
    const correlated = recentCommits.find(c => pathWords.some(w => (c.message || "").toLowerCase().includes(w)));
    narrative.push(`Linked repo ${repoUrl || ""} — last ${recentCommits.length} commits: ${recentCommits.map(c => `${(c.sha || "").slice(0, 7)} ${(c.message || "").split("\n")[0]}`).join(" | ")}.`);
    if (correlated) {
      narrative.push(`Recent commit ${(correlated.sha || "").slice(0, 7)} touches this area ("${(correlated.message || "").split("\n")[0]}") — a likely regression source.`);
      fixes.unshift(fix(`Review recent commit ${(correlated.sha || "").slice(0, 7)}`, `This commit mentions the failing area: "${(correlated.message || "").split("\n")[0]}". Inspect its diff first.`, "code", correlated.url));
    }
  }

  if (recurring >= 3) {
    narrative.push(`This path has failed ${recurring + 1} times recently — recurring issue.`);
    if (severity === "low") severity = "medium"; else if (severity === "medium") severity = "high";
  }

  return { mode: "mock", severity, summary, rootCause: { summary: rootCause, confidence }, suggestedFixes: fixes, confidence, reasoning: narrative.join(" ") };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool definitions exposed to Groq (mirror the Agent Connector's tools + codebase)
// ─────────────────────────────────────────────────────────────────────────────

const SERVICE_CHECKS = {
  database: ["health", "metrics", "logs"],
  auth: ["health", "metrics", "logs"],
  external_api: ["health", "metrics", "logs"]
};

const TOOL_DESCRIPTIONS = {
  "database.health": "Inspect database availability and connection health.",
  "database.metrics": "Read database connection-pool and query-performance metrics.",
  "database.logs": "Read recent database diagnostic logs.",
  "auth.health": "Inspect authentication service and identity-store health.",
  "auth.metrics": "Read authentication throughput, failures and latency metrics.",
  "auth.logs": "Read recent authentication diagnostic logs.",
  "external_api.health": "Inspect configured third-party API availability.",
  "external_api.metrics": "Read third-party API latency, timeout and error metrics.",
  "external_api.logs": "Read recent third-party API integration logs."
};

function buildToolDefinitions() {
  const tools = [];
  for (const [service, checks] of Object.entries(SERVICE_CHECKS)) {
    for (const check of checks) {
      tools.push({
        type: "function",
        function: {
          name: `inspect_${service}_${check}`,
          description: `${TOOL_DESCRIPTIONS[`${service}.${check}`]} Read-only.`,
          parameters: { type: "object", properties: {}, additionalProperties: false }
        }
      });
    }
  }
  tools.push({
    type: "function",
    function: {
      name: "search_codebase",
      description: "Find relevant source files in the linked codebase by keyword. Read-only. Returns up to 5 matches with file path, line number, and snippet.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keyword or phrase to search for (e.g. 'connection pool', 'auth token', 'timeout')." }
        },
        required: ["query"],
        additionalProperties: false
      }
    }
  });
  return tools;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool execution (read-only)
// ─────────────────────────────────────────────────────────────────────────────

async function executeConnectorTool(name, cfg) {
  const url = new URL("/connector/execute", cfg.CONNECTOR_URL);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.CONNECTOR_API_TOKEN}`
      },
      body: JSON.stringify({ tool: name }),
      signal: controller.signal
    });
    if (!res.ok) return { error: `connector HTTP ${res.status}` };
    const data = await res.json();
    return data.result || { error: "no result" };
  } catch (e) {
    return { error: e.name === "AbortError" ? "connector timeout" : (e.message || "connector unreachable") };
  } finally {
    clearTimeout(timeout);
  }
}

async function executeTool(name, args, input, cfg) {
  if (name.startsWith("inspect_")) {
    return executeConnectorTool(name, cfg);
  }

  if (name === "search_codebase") {
    // Build an incident-shaped object so inspectCodebase derives useful keywords.
    const query = String(args?.query || "").slice(0, 200);
    const incidentForSearch = {
      path: input.incident.path,
      error: input.incident.error,
      responseSample: query || input.incident.responseSample
    };
    try {
      const findings = await inspectCodebase(incidentForSearch);
      return findings.slice(0, 5);
    } catch (e) {
      return { error: e.message || "codebase search failed" };
    }
  }

  return { error: `unknown tool: ${name}` };
}
// ─────────────────────────────────────────────────────────────────────────────
// Groq agent loop
// ─────────────────────────────────────────────────────────────────────────────
//
// The prompt is configuration, not code: see prompts.mjs. `resolvePromptSettings`
// merges (1) the runtime override saved by POST /config, (2) GROQ_* env vars, and
// (3) the selected built-in profile. That is what makes A/B testing different
// prompting strategies possible without redeploying.

const MAX_TOOL_ITERATIONS = 6;

/**
 * Tolerant final-answer parser. Handles the two failure modes we kept hitting:
 *   - the model wraps the JSON in prose or a markdown fence;
 *   - the model emits confidence (or rootCause.confidence) as a string.
 * Returns null (never throws) when the shape is genuinely unusable.
 */
function parseFinalAnswer(content) {
  if (!content || typeof content !== "string") return null;

  // 1. Extract the outermost JSON object regardless of surrounding prose/fences.
  const first = content.indexOf("{");
  const last = content.lastIndexOf("}");
  if (first === -1 || last <= first) return null;

  let parsed;
  try { parsed = JSON.parse(content.slice(first, last + 1)); }
  catch { return null; }

  // 2. Coerce stringified numbers (the model frequently emits "0.82").
  if (typeof parsed.confidence === "string") parsed.confidence = Number(parsed.confidence);
  if (parsed.rootCause && typeof parsed.rootCause === "object" && typeof parsed.rootCause.confidence === "string") {
    parsed.rootCause.confidence = Number(parsed.rootCause.confidence);
  }

  if (!parsed.severity || !parsed.rootCause ||
      typeof parsed.confidence !== "number" || !Number.isFinite(parsed.confidence) ||
      !Array.isArray(parsed.suggestedFixes)) {
    return null;
  }

  // Normalise fixes so the UI can always render a diff block when one exists.
  const suggestedFixes = parsed.suggestedFixes.slice(0, 8).map(f => ({
    title: String(f?.title || ""),
    description: String(f?.description || ""),
    kind: String(f?.kind || "other"),
    ...(f?.file ? { file: String(f.file) } : {}),
    ...(typeof f?.diff === "string" && f.diff.trim() ? { diff: f.diff } : {})
  }));

  const rollbackDecision = parsed.rollbackDecision && typeof parsed.rollbackDecision === "object"
    ? {
        shouldRollback: Boolean(parsed.rollbackDecision.shouldRollback),
        targetCommitSha: parsed.rollbackDecision.targetCommitSha ? String(parsed.rollbackDecision.targetCommitSha) : null,
        reason: String(parsed.rollbackDecision.reason || "")
      }
    : { shouldRollback: false, targetCommitSha: null, reason: "No rollback recommended" };

  return {
    mode: "live",
    severity: String(parsed.severity).toLowerCase(),
    summary: String(parsed.summary || ""),
    rootCause: {
      summary: String(parsed.rootCause.summary || ""),
      confidence: Math.max(0, Math.min(1, Number(parsed.rootCause.confidence) || 0))
    },
    suggestedFixes,
    rollbackDecision,
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence))),
    reasoning: String(parsed.reasoning || "")
  };
}

/** Everything the model is allowed to know, flattened into template variables. */
export function buildPromptVariables(input, cfg = defaultConfig) {
  const dependencyFindings = deriveDependencyFindings(input.dependency || { results: [] });
  const codeFindings = (input.codeFindings || []).slice(0, 3).map(f => ({
    file: f.file,
    line: f.line,
    snippet: String(f.snippet || "").slice(0, 400),
    reason: f.reason
  }));
  const recentCommits = (input.recentCommits || []).map(c => ({
    sha: String(c.sha || "").slice(0, 7),
    message: String(c.message || "").split("\n")[0]
  }));

  const incident = {
    method: input.incident?.method,
    path: input.incident?.path,
    statusCode: input.incident?.statusCode,
    category: input.incident?.category,
    reason: input.incident?.reason,
    responseSample: input.incident?.responseSample?.slice(0, 800),
    error: input.incident?.error
  };

  const evidence = [
    "dependency findings:",
    JSON.stringify(dependencyFindings, null, 2),
    "code findings:",
    JSON.stringify(codeFindings, null, 2),
    `recurring on this path: ${input.recurring ?? 0}`,
    recentCommits.length ? `recent commits:\n${JSON.stringify(recentCommits, null, 2)}` : "recent commits: none",
    Array.isArray(cfg.codebase?.diffs) && cfg.codebase.diffs.length
      ? `recent git diffs (last ${cfg.codebase.diffs.length}):\n${JSON.stringify(cfg.codebase.diffs.map(d => ({ sha: d.shortSha || d.sha, message: d.message, files: (d.files || []).map(f => ({ filename: f.filename, status: f.status, patch: String(f.patch || "").slice(0, 800) })) })), null, 2)}`
      : "recent git diffs: none",
    input.repoUrl ? `repository: ${input.repoUrl}` : "repository: not linked"
  ].join("\n");

  const liquid = input.liquid
    ? {
        route: input.liquid.route,
        decision: input.liquid.decision,
        reasons: input.liquid.reasons,
        evidence: input.liquid.evidence
      }
    : null;

  return {
    incident: JSON.stringify({ ...incident, recurring: input.recurring, repoUrl: input.repoUrl }, null, 2),
    dependencyFindings: JSON.stringify(dependencyFindings, null, 2),
    codeFindings: JSON.stringify(codeFindings, null, 2),
    recentCommits: JSON.stringify(recentCommits, null, 2),
    repoUrl: input.repoUrl || "none",
    recurring: String(input.recurring ?? 0),
    liquid: liquid ? JSON.stringify(liquid, null, 2) : "none (Liquid AI was not consulted or returned no decision)",
    tools: TOOL_NAMES.join(", "),
    evidence
  };
}

/**
 * One chat-completions call, with the debug JSON log the operator asked for.
 * Returns { ok, data } or { ok:false, error } — never throws.
 */
async function postChat(baseUrl, cfg, body, debug) {
  const url = `${baseUrl}/chat/completions`;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${cfg.GROQ_API_KEY}` };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.LLM_TIMEOUT_MS);
  const started = Date.now();
  try {
    // Change 2: reasoning-model parameters for openai/gpt-oss-* models.
    // Ignored by Groq for non-reasoning models, but gated here to be explicit.
    const isReasoningModel = /gpt-oss/i.test(cfg.GROQ_MODEL || "");
    const requestBody = body;

    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(requestBody), signal: controller.signal });
    const text = await res.text();
    const durationMs = Date.now() - started;

    // ── debug JSON of the API call (console.log + optional analysis record) ──
    const record = debugRecord({
      provider: "groq",
      ok: res.ok,
      durationMs,
      request: { method: "POST", url, headers, body: requestBody },
      response: { status: res.status, body: text },
      error: res.ok ? undefined : `HTTP ${res.status}`
    });
    logAiCall("groq_ai_call", { provider: "groq", ok: res.ok, durationMs, request: record.request, response: record.response });
    if (debug) debug.push(record);

    if (!res.ok) {
      // Change 3: classify the error so the UI/logs distinguish retryable from fatal.
      const retryable = [408, 429, 500, 502, 503, 504].includes(res.status);
      const kind =
        res.status === 401 ? "invalid_api_key" :
        res.status === 403 ? "forbidden" :
        res.status === 404 ? "model_not_found" :
        res.status === 429 ? "rate_limited" :
        res.status >= 500  ? "provider_error" :
                             "bad_request";

      log("warn", "llm_http_error", { status: res.status, kind, retryable, body: text.slice(0, 300) });
      return {
        ok: false,
        error: `HTTP ${res.status} (${kind})`,
        kind,
        retryable,
        status: res.status,
        body: text.slice(0, 300),
        durationMs
      };
    }
    try {
      return { ok: true, data: JSON.parse(text), durationMs };
    } catch {
      log("warn", "llm_invalid_json", { head: text.slice(0, 200) });
      return { ok: false, error: "invalid JSON from provider", durationMs };
    }
  } catch (e) {
    const durationMs = Date.now() - started;
    const error = e.name === "AbortError" ? "timeout" : (e.message || "network error");
    const record = debugRecord({
      provider: "groq",
      ok: false,
      durationMs,
      request: { method: "POST", url, headers, body },
      error
    });
    logAiCall("groq_ai_call", { provider: "groq", ok: false, durationMs, request: record.request, error });
    if (debug) debug.push(record);
    log("warn", "llm_fetch_failed", { error });
    return { ok: false, error, durationMs };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Live reasoning through Groq. Returns the parsed diagnosis extended with
 * `aiDebug` (when cfg.AI_DEBUG) and `llmError` when a call failed, or null when
 * the provider is not configured / nothing usable came back.
 */
export async function groqReason(input, cfg = defaultConfig) {
  if (!cfg.GROQ_API_KEY) { log("warn", "llm_skipped", { reason: "no GROQ_API_KEY" }); return null; }

  const settings = resolvePromptSettings(cfg);
  const variables = buildPromptVariables(input, cfg);
  const messages = [
    { role: "system", content: settings.systemPrompt },
    { role: "user", content: renderTemplate(settings.userPromptTemplate, variables) }
  ];

  const tools = buildToolDefinitions();
  const baseUrl = String(cfg.GROQ_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, "");
  const debug = [];
  let lastError = null;

  log("info", "llm_prompt_resolved", {
    profile: settings.profile,
    custom: settings.isCustom,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    model: cfg.GROQ_MODEL,
    promptChars: settings.systemPrompt.length + settings.userPromptTemplate.length
  });

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const result = await postChat(baseUrl, cfg, {
      model: cfg.GROQ_MODEL,
      messages,
      tools,
      tool_choice: "auto",
      temperature: settings.temperature,
      max_completion_tokens: settings.maxTokens
    }, debug);

    if (!result.ok) {
      lastError = result.error;
      // A provider error mid-loop is fatal for this incident: fall back cleanly.
      return attachDebug(null, debug, cfg, lastError);
    }
    const data = result.data;
    const msg = data.choices?.[0]?.message;
    const finish = data.choices?.[0]?.finish_reason;
    if (!msg) { log("warn", "llm_empty_message", { iteration: i, finish }); return attachDebug(null, debug, cfg, "empty message"); }

    // Append the assistant message (may include tool_calls).
    messages.push({
      role: "assistant",
      content: msg.content ?? "",
      ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {})
    });

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
			const parsed = parseFinalAnswer(msg.content);
			if (parsed) return attachDebug(parsed, debug, cfg, null);
			log("warn", "llm_parse_failed", { iteration: i, finish, head: (msg.content || "").slice(0, 400) });
			break; // fall through to forced JSON-mode call
		}

    // Execute tool calls in order; append each result with matching tool_call_id.
    for (const call of msg.tool_calls) {
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch { /* keep {} */ }
      const result2 = await executeTool(call.function?.name || "", args, input, cfg);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result2)
      });
    }
  }

  // Hit iteration limit — force a final answer without tools.
  log("warn", "llm_iteration_limit", { iterations: MAX_TOOL_ITERATIONS });
  messages.push({
    role: "user",
    content: "Stop calling tools. Return the final JSON diagnosis now using the evidence you have gathered."
  });

  const forced = await postChat(baseUrl, cfg, {
    model: cfg.GROQ_MODEL,
    messages,
    temperature: settings.temperature,
    max_completion_tokens: settings.maxTokens,
    response_format: { type: "json_object" }
  }, debug);

  if (!forced.ok) return attachDebug(null, debug, cfg, forced.error);
  const parsed = parseFinalAnswer(forced.data.choices?.[0]?.message?.content);
  if (!parsed) {
    log("warn", "llm_parse_failed", { stage: "forced_final", head: (forced.data.choices?.[0]?.message?.content || "").slice(0, 400) });
    return attachDebug(null, debug, cfg, "unparseable forced final answer");
  }
  return attachDebug(parsed, debug, cfg, null);
}

/**
 * Uniform return shape: { parsed, aiDebug?, llmError? }.
 * `parsed` is null whenever nothing usable came back, so callers never have to
 * guess whether an error object holds a diagnosis or a failure detail.
 */
function attachDebug(parsed, debug, cfg, llmError) {
  const out = { parsed: parsed || null };
  if (cfg.AI_DEBUG && Array.isArray(debug) && debug.length) out.aiDebug = debug;
  if (llmError || !parsed) out.llmError = llmError || "llm unavailable";
  return out;
}

/**
 * Route to the LLM, then fall back to the deterministic heuristic.
 * A failed Groq call is surfaced as `llmWarning` so the UI can show it in red
 * instead of silently pretending the heuristic answer came from the model.
 */
export async function reason(input, cfg = defaultConfig) {
  if (cfg.AGENT_MODE === "live" && cfg.GROQ_API_KEY) {
    const raw = await groqReason(input, cfg);
    const live = raw?.parsed;
    const debug = raw?.aiDebug;
    const llmError = raw?.llmError;

    if (live) return { ...live, ...(debug ? { aiDebug: debug } : {}) };

    log("warn", "llm_fallback_to_heuristic", {
      incidentId: input.incident?.id,
      path: input.incident?.path,
      error: llmError
    });
    const fallback = heuristicReason(input);
    return {
      ...fallback,
      llmWarning: `Groq AI call failed (${llmError || "no usable answer"}) — fell back to the heuristic reasoner.`,
      ...(debug && cfg.AI_DEBUG ? { aiDebug: debug } : {})
    };
  }
  return heuristicReason(input);
}
