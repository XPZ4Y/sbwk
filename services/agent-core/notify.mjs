// Notification -> Developer Team. Always logs; optionally posts to a webhook.
import { config } from "./config.mjs";

export async function notifyEngineer(incident, analysis, reason) {
  const at = new Date().toISOString();
  const channel = config.NOTIFICATION_WEBHOOK_URL ? "webhook+log" : "log";
  console.log(JSON.stringify({ level: "warn", event: "engineer_notification", service: "agent-core", timestamp: at, incidentId: incident.id, severity: analysis.severity, reason, summary: analysis.summary, channel }));

  if (!config.NOTIFICATION_WEBHOOK_URL) return { sent: true, channel: "log", reason, at };

  const text = `[SBWK] Engineer attention needed — ${analysis.severity.toUpperCase()} ${incident.method} ${incident.path} (HTTP ${incident.statusCode}). ${analysis.summary} Root cause: ${analysis.rootCause.summary}. Reason: ${reason}. Incident ${incident.id}.`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.REQUEST_TIMEOUT_MS);
  try {
    await fetch(config.NOTIFICATION_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, incidentId: incident.id, severity: analysis.severity, summary: analysis.summary, rootCause: analysis.rootCause, suggestedFixes: analysis.suggestedFixes, reason }),
      signal: controller.signal
    });
    return { sent: true, channel: "webhook+log", reason, at };
  } catch {
    return { sent: false, channel: "log", reason, at };
  } finally {
    clearTimeout(timeout);
  }
}
