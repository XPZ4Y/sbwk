// Reasoning: dependency findings + deterministic heuristic + optional Groq LLM.
import { config as defaultConfig } from "./config.mjs";

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

const fix = (title, description, kind, file) => ({ title, description, kind, file });

export function heuristicReason(input) {
  const { incident, dependency, codeFindings, recurring, recentCommits = [], repoUrl } = input;
  const findings = deriveDependencyFindings(dependency);
  const primary = unhealthyServices(findings)[0];
  let severity = "medium", summary, rootCause, confidence, fixes;
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
        fix("Verify database connectivity and pool", "Check the database is reachable and the connection pool is not exhausted; raise pool size or fix leaked connections.", "dependency"),
        fix("Add query timeouts and retry/backoff", "Wrap database calls with bounded timeouts and exponential backoff so transient failures degrade gracefully.", "code", codeFindings[0]?.file),
        fix("Inspect slow queries", "Review the slowest queries and add indexes or pagination where average query time is high.", "dependency")
      ];
    } else if (svc === "external_api") {
      severity = "high";
      summary = `Request failed because a third-party API dependency is ${primary.status}.`;
      rootCause = "An upstream third-party API is returning errors or timing out, propagating failure to this request.";
      confidence = primary.status === "unhealthy" ? 0.78 : 0.6;
      fixes = [
        fix("Add a circuit breaker and fallback", "Stop hammering a failing upstream; serve a cached/fallback response while it recovers.", "code", codeFindings[0]?.file),
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
        fix("Handle auth failures gracefully", "Return a clear 401/503 and avoid cascading 500s when auth is degraded.", "code", codeFindings[0]?.file)
      ];
    }
  } else if (incident.category === "upstream_unreachable" || incident.category === "timeout") {
    severity = "high";
    summary = "The application Server itself was unreachable or timed out.";
    rootCause = "The Server process is down, crashed, or overloaded (no dependency failure was detected).";
    confidence = 0.7;
    fixes = [fix("Check Server process and health", "Confirm the Server is running and its /health endpoint responds; inspect restart/crash loops.", "investigation"), fix("Review resource saturation", "Check CPU/memory and consider scaling or a readiness probe.", "config")];
    narrative.push("No dependency failure detected; the Server endpoint did not respond.");
  } else if (incident.category === "client_error") {
    severity = "low";
    summary = `Client error HTTP ${incident.statusCode} on ${incident.path}.`;
    rootCause = "The requested route or resource does not exist or the request was malformed (e.g. missing route registration or wrong path).";
    confidence = 0.6;
    fixes = [fix("Verify route registration", `Confirm ${incident.path} is registered and the HTTP method matches.`, "code", codeFindings[0]?.file), fix("Check client request", "Validate the client is calling the correct path and parameters.", "investigation")];
    narrative.push("No dependency failure detected; this is a client-side/routing error.");
  } else if (incident.category === "slow_response") {
    severity = "medium";
    summary = `Slow response on ${incident.path} (${Math.round(incident.durationMs)}ms).`;
    rootCause = "The request exceeded the latency threshold — likely a performance regression, an unindexed query, or downstream latency.";
    confidence = 0.5;
    fixes = [fix("Profile the slow endpoint", "Trace the request to find the slow span (query, external call, or CPU).", "investigation", codeFindings[0]?.file), fix("Add caching / pagination / indexes", "Cache hot reads, paginate large results, and index slow queries.", "code", codeFindings[0]?.file)];
    narrative.push("No dependency outage detected; the response was slower than the configured threshold.");
  } else if (codeFindings.length > 0) {
    severity = "medium";
    summary = `Application error on ${incident.path}; relevant code located.`;
    rootCause = `An unhandled error in the application code path (see ${codeFindings[0].file}) is the most likely cause.`;
    confidence = 0.55;
    fixes = [fix("Add error handling around the failing path", "Inspect the matched handler and add validation / try-catch with a meaningful error response.", "code", codeFindings[0].file), fix("Reproduce with the captured request", "Use the incident request and response sample to reproduce locally.", "investigation")];
    narrative.push(`Dependencies look healthy; matched ${codeFindings.length} relevant code location(s).`);
  } else {
    severity = "medium";
    summary = `Unclassified HTTP ${incident.statusCode} on ${incident.path}.`;
    rootCause = "Insufficient evidence to determine a root cause automatically.";
    confidence = 0.3;
    fixes = [fix("Gather more evidence", "Enable richer application logs/tracing for this route and re-run the request.", "investigation"), fix("Manual inspection", "An engineer should review the request path and recent deployments.", "investigation")];
    narrative.push("No dependency failure and no relevant code found; evidence is insufficient.");
  }

  // Correlate the failing request with the last commits of the linked repository.
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

const SYSTEM_PROMPT = [
  "You are SBWK Agent Core, a read-only site-reliability assistant.",
  "You diagnose production incidents using ONLY the evidence provided.",
  "Do not invent facts about dependencies that are reported healthy.",
  "You suggest fixes but NEVER execute, deploy, restart or remediate anything.",
  "Respond with ONLY a JSON object (no markdown) with keys:",
  "severity (low|medium|high|critical), summary (string),",
  "rootCause {summary, confidence 0..1}, confidence (0..1),",
  "suggestedFixes (array of {title, description, kind: config|code|dependency|investigation, file?}),",
  "reasoning (string). Prefer dependency root causes when a dependency is unhealthy."
].join(" ");

export async function groqReason(input, cfg = defaultConfig) {
  if (!cfg.GROQ_API_KEY) return null;
  const evidence = {
    incident: { method: input.incident.method, path: input.incident.path, statusCode: input.incident.statusCode, category: input.incident.category, reason: input.incident.reason, responseSample: input.incident.responseSample?.slice(0, 800), error: input.incident.error },
    dependencies: deriveDependencyFindings(input.dependency),
    connectorError: input.dependency.error,
    codeFindings: input.codeFindings.map(f => ({ file: f.file, line: f.line, snippet: f.snippet.slice(0, 600), reason: f.reason })),
    recurringFailuresOnPath: input.recurring,
    repository: input.repoUrl,
    recentCommits: (input.recentCommits || []).map(c => ({ sha: (c.sha || "").slice(0, 7), message: (c.message || "").split("\n")[0], author: c.author, date: c.date }))
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.LLM_TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.GROQ_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.GROQ_API_KEY}` },
      signal: controller.signal,
      body: JSON.stringify({ model: cfg.GROQ_MODEL, temperature: 0.2, max_tokens: 1200, response_format: { type: "json_object" }, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: `Diagnose this incident and return the JSON object.\n\nEVIDENCE:\n${JSON.stringify(evidence)}` }] })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const v = JSON.parse(content);
    if (!v.severity || !v.rootCause || typeof v.confidence !== "number" || !Array.isArray(v.suggestedFixes)) return null;
    return { mode: "live", severity: v.severity, summary: String(v.summary || ""), rootCause: { summary: String(v.rootCause.summary || ""), confidence: Number(v.rootCause.confidence) || 0 }, suggestedFixes: v.suggestedFixes.slice(0, 8), confidence: Number(v.confidence), reasoning: String(v.reasoning || "") };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function reason(input, cfg = defaultConfig) {
  if (cfg.AGENT_MODE === "live" && cfg.GROQ_API_KEY) {
    const live = await groqReason(input, cfg);
    if (live) return live;
  }
  return heuristicReason(input);
}
