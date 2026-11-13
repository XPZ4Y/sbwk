// Investigation orchestrator. Dependencies are injected for testability.
//
// Flow per incident:
//   connector evidence + codebase  →  Liquid d1 triage  →┬─ "engineer": hand to a human (no LLM)
//                                                        └─ "groq":     Groq reasons, proposes fixes
// Anything Liquid cannot decide (no key, timeout, HTTP error) falls through to
// Groq, exactly as required, and the failure is carried into the analysis so the
// UI can show it in red instead of hiding it.
import { config as defaultConfig, investigateServices as defaultServices } from "./config.mjs";
import { deriveDependencyFindings, hasUnreachableDependency } from "./reason.mjs";
import { liquidTriage, ROUTES } from "./liquid.mjs";
import { resolvePromptSettings } from "./prompts.mjs";

const log = (level, event, fields = {}) =>
  console.log(JSON.stringify({ level, event, service: "agent-core", timestamp: new Date().toISOString(), ...fields }));

/** Read-only client for the Agent Connector. Outages become error results, never throws. */
export function makeConnectorClient(cfg = defaultConfig) {
  return async function investigateDependencies(services) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cfg.REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(new URL("/connector/investigate", cfg.CONNECTOR_URL), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.CONNECTOR_API_TOKEN}` },
        body: JSON.stringify({ services }),
        signal: controller.signal
      });
      if (!res.ok) return { results: [], error: `Connector returned HTTP ${res.status}` };
      const data = await res.json();
      return { results: Array.isArray(data.results) ? data.results : [], summary: data.summary };
    } catch (e) {
      return { results: [], error: e.message || "Connector unreachable" };
    } finally {
      clearTimeout(timeout);
    }
  };
}

const SEVERITY_LADDER = ["low", "medium", "high", "critical"];
const bump = (sev, steps = 1) => SEVERITY_LADDER[Math.min(SEVERITY_LADDER.length - 1, SEVERITY_LADDER.indexOf(sev) + steps)];

/** Severity purely from the observed request, used when no model diagnoses it. */
export function severityFromIncident(incident) {
  if (incident.category === "upstream_unreachable" || incident.category === "timeout" || incident.category === "server_error") return "high";
  if (incident.category === "slow_response") return "medium";
  if (incident.category === "client_error") return "low";
  return (incident.statusCode || 0) >= 500 ? "high" : "medium";
}

/**
 * Build the analysis for "Liquid says a human owns this". No LLM runs, so the
 * result is a hand-off briefing rather than a code diagnosis.
 */
export function engineerRouteResult({ incident, triage, dependencyFindings = [], codeFindings = [] }) {
  const d = triage.decision || {};
  let severity = severityFromIncident(incident);
  if (typeof d.urgencyProbability === "number" && d.urgencyProbability >= 0.8) severity = bump(severity);

  const department = d.department || "engineering";
  const bits = [];
  bits.push(`Liquid d1 routed this incident to the ${department} team instead of automated diagnosis.`);
  if (d.urgencyProbability !== null && d.urgencyProbability !== undefined) bits.push(`urgency ${(d.urgencyProbability * 100).toFixed(0)}%`);
  if (d.frustrationScore !== null && d.frustrationScore !== undefined) {
    bits.push(`frustration ${d.frustrationScore.toFixed(2)}${d.frustrationLabel ? ` (${d.frustrationLabel})` : ""}`);
  }
  if (d.departmentConfidence !== null && d.departmentConfidence !== undefined) bits.push(`department confidence ${(d.departmentConfidence * 100).toFixed(0)}%`);

  const fixes = [{
    title: `Hand off to the ${department} team`,
    description: [
      `A human should own this: ${(triage.reasons || []).join("; ") || "Liquid d1 flagged it for human review"}.`,
      dependencyFindings.length ? `Dependency evidence: ${dependencyFindings.map(f => `${f.service}=${f.status}`).join(", ")}.` : "No dependency evidence was gathered.",
      codeFindings.length ? `Nearest code: ${codeFindings[0].file}${codeFindings[0].line ? `:${codeFindings[0].line}` : ""}.` : "No matching code was located."
    ].join(" "),
    kind: "investigation"
  }];

  return {
    mode: "engineer",
    severity,
    summary: `Routed to a human engineer (${department}) by Liquid AI before any code diagnosis ran.`,
    rootCause: {
      summary: `Not a code-diagnosis case: ${(triage.reasons || []).join("; ") || "Liquid d1 flagged it for human review"}.`,
      confidence: 0.35
    },
    suggestedFixes: fixes,
    confidence: 0.35,
    reasoning: bits.join(" · ")
  };
}

export function createInvestigator(deps) {
  const { store, investigateDependencies, inspectCodebase, reason, notifyEngineer, config, services } = deps;
  // Injected for tests; production passes the real Liquid client from server.mjs.
  const triage = deps.triage || liquidTriage;

  function decideEscalation(incident, result, findings, connectorError, recurring, routing) {
    const reasons = [];
    if (routing?.route === ROUTES.ENGINEER) reasons.push(`Liquid AI routed to a human: ${(routing.reasons || []).join("; ") || "human review requested"}`);
    if (result.confidence < config.ESCALATION_CONFIDENCE_THRESHOLD) reasons.push(`low confidence (${(result.confidence * 100).toFixed(0)}%)`);
    if (result.severity === "critical") reasons.push("critical severity");
    if (connectorError) reasons.push("connector unreachable");
    if (hasUnreachableDependency(findings)) reasons.push("a dependency is unreachable");
    if (incident.category === "upstream_unreachable" || incident.category === "timeout") reasons.push("application server unreachable");
    if (recurring >= 3) reasons.push(`recurring failure (${recurring + 1}x on this path)`);
    return { escalate: reasons.length > 0, escalationReason: reasons.join("; ") || undefined };
  }

  /** Public shape of the router outcome, stored on every analysis. */
  function routingSummary(t) {
    return {
      provider: t.provider || "liquid",
      model: t.model || null,
      route: t.route || ROUTES.GROQ,
      ok: t.ok !== false,
      status: t.status || "unknown",
      skipped: Boolean(t.skipped),
      reasons: t.reasons || [],
      decision: t.decision || null,
      warnings: t.warnings || [],
      httpStatus: t.httpStatus,
      latencyMs: t.latencyMs ?? null
    };
  }

  async function process(record) {
    const incident = record.incident;
    const recurring = store.recurrenceForPath(incident.path, incident.id);
    log("info", "investigation_started", { incidentId: incident.id, path: incident.path, recurring });

    const [dependency, codeFindings] = await Promise.all([investigateDependencies(services), inspectCodebase(incident)]);
    const recentCommits = config.codebase?.commits || [];
    const repoUrl = config.codebase?.repoUrl;
    const baseInput = { incident, dependency, codeFindings, recurring, recentCommits, repoUrl };

    // ── 1. Liquid d1 triage: engineer intervention, or hand to Groq? ────────
    let triageResult;
    try {
      triageResult = await triage(baseInput, config);
    } catch (e) {
      // The client is defensive, but a contract violation must never kill an incident.
      triageResult = {
        provider: "liquid", ok: false, route: ROUTES.GROQ, status: "client_error",
        reasons: ["Liquid AI client threw"], latencyMs: 0,
        warnings: [{ severity: "error", message: `Liquid AI triage crashed (${e.message}) — fell back to Groq AI.` }]
      };
    }
    log("info", "liquid_triage_completed", {
      incidentId: incident.id, route: triageResult.route, status: triageResult.status,
      ok: triageResult.ok, latencyMs: triageResult.latencyMs
    });

    // ── 2. Reason: human hand-off, or the Groq/heuristic reasoner ───────────
    const result = triageResult.route === ROUTES.ENGINEER
      ? engineerRouteResult({ incident, triage: triageResult, dependencyFindings: deriveDependencyFindings(dependency), codeFindings })
      : await reason({ ...baseInput, liquid: triageResult });

    const dependencyFindings = deriveDependencyFindings(dependency);
    const routing = routingSummary(triageResult);
    const warnings = [...(triageResult.warnings || [])];
    if (result.llmWarning) warnings.push({ severity: "error", message: result.llmWarning });

    const { escalate, escalationReason } = decideEscalation(incident, result, dependencyFindings, dependency.error, recurring, routing);
    const prompt = resolvePromptSettings(config);
    // Debug trail: the Liquid triage call first, then every Groq call.
    const debugTrail = config.AI_DEBUG ? [...(triageResult.aiDebug || []), ...(result.aiDebug || [])] : [];

    const analysis = {
      incidentId: incident.id, mode: result.mode, severity: result.severity, summary: result.summary,
      rootCause: result.rootCause, suggestedFixes: result.suggestedFixes, dependencyFindings, codeFindings,
      confidence: result.confidence, escalate, escalationReason, reasoning: result.reasoning, recurring,
      recentCommits, repoUrl,
      // ── new in v0.2.0 ────────────────────────────────────────────────────
      routing,
      warnings,
      prompt: { profile: prompt.profile, temperature: prompt.temperature, maxTokens: prompt.maxTokens, isCustom: prompt.isCustom },
      ...(debugTrail.length ? { aiDebug: debugTrail } : {}),
      policy: { dryRun: config.DRY_RUN, autoRollback: config.AUTO_ROLLBACK, escalationThreshold: config.ESCALATION_CONFIDENCE_THRESHOLD },
      monitoringActive: config.MONITORING_ACTIVE,
      createdAt: new Date().toISOString()
    };
    store.attachAnalysis(incident.id, analysis);
    log("info", "incident_analyzed", {
      incidentId: incident.id, mode: analysis.mode, severity: analysis.severity,
      confidence: analysis.confidence, escalate, route: routing.route, warnings: warnings.length
    });

    const mailConfiguredOrPartial = Boolean(
      (typeof config.RESEND_API_KEY === "string" && config.RESEND_API_KEY.trim()) ||
      (typeof config.DEVELOPER_EMAIL === "string" && config.DEVELOPER_EMAIL.trim())
    );
    const shouldNotifyResend = Boolean(config.RESEND_NOTIFY_ALL_INCIDENTS !== false && mailConfiguredOrPartial);
    if (escalate || shouldNotifyResend) {
      const triggerReason = escalationReason || (escalate ? "escalation policy" : "fault detected (Resend notification)");
      let notification;
      try {
        notification = await notifyEngineer(incident, analysis, triggerReason, { config });
      } catch (err) {
        log("error", "notification_crashed", { incidentId: incident.id, error: err?.message || String(err) });
        notification = {
          sent: false,
          channel: "log",
          reason: triggerReason,
          at: new Date().toISOString(),
          errors: [{ channel: "notification", code: "unexpected_error", message: err?.message || String(err) }]
        };
      }
      if (notification?.email && !notification.email.sent && notification.email.code !== "not_configured") {
        analysis.warnings = [
          ...(analysis.warnings || []),
          {
            severity: "error",
            source: "resend",
            code: notification.email.code || "email_failed",
            message: `Email alert failed (${notification.email.code || "error"}): ${notification.email.error || notification.email.reason || "delivery failed"}`,
            ...(notification.email.hint ? { detail: notification.email.hint } : {})
          }
        ];
      }
      store.setNotification(incident.id, notification);
    }
    return store.get(incident.id);
  }

  function startInvestigation(incident) {
    const record = store.create(incident);
    const completion = process(record).catch(e => {
      log("error", "investigation_failed", { incidentId: incident.id, error: e.message });
      return store.get(incident.id);
    });
    return { record, completion };
  }

  return { startInvestigation, runInvestigation: incident => startInvestigation(incident).completion };
}
