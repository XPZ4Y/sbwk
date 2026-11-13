// Notification -> Developer Team. Always logs; optionally posts to a webhook and/or sends email via Resend.com.
import { config } from "./config.mjs";

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function sendResendEmail(incident, analysis, reason, fetchImpl = globalThis.fetch) {
  if (!config.RESEND_API_KEY || !config.DEVELOPER_EMAIL) {
    return { attempted: false, sent: false, reason: "resend not configured" };
  }

  const severity = (analysis?.severity || "unknown").toUpperCase();
  const method = incident?.method || "REQ";
  const path = incident?.path || "/";
  const status = incident?.statusCode ?? "ERR";
  const summary = analysis?.summary || "Application fault detected";
  const rootCause = analysis?.rootCause?.summary || "Under investigation";
  const fixes = Array.isArray(analysis?.suggestedFixes) ? analysis.suggestedFixes : [];
  const rollback = analysis?.rollbackDecision;

  const subject = `[SBWK] ${severity} Fault: ${method} ${path} (HTTP ${status})`;
  const textLines = [
    `SBWK Fault Notification`,
    `Severity: ${severity}`,
    `Endpoint: ${method} ${path} (HTTP ${status})`,
    `Incident ID: ${incident?.id || "n/a"}`,
    `Reason: ${reason}`,
    `Summary: ${summary}`,
    `Root Cause: ${rootCause}`,
    fixes.length ? `Suggested Fixes:\n${fixes.map((f, i) => `  ${i + 1}. ${typeof f === "string" ? f : f.description || JSON.stringify(f)}`).join("\n")}` : null,
    rollback?.shouldRollback ? `Rollback Recommended: YES (target: ${rollback.targetCommitSha || "latest"}) — ${rollback.reason || ""}` : null
  ].filter(Boolean);

  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:640px;margin:0 auto;padding:16px;border:1px solid #e5e7eb;border-radius:8px;">
      <h2 style="margin:0 0 12px;color:#b91c1c;">[SBWK] ${escapeHtml(severity)} Fault Detected</h2>
      <p style="margin:4px 0;"><strong>Endpoint:</strong> <code>${escapeHtml(method)} ${escapeHtml(path)}</code> (HTTP ${escapeHtml(status)})</p>
      <p style="margin:4px 0;"><strong>Incident ID:</strong> <code>${escapeHtml(incident?.id || "n/a")}</code></p>
      <p style="margin:4px 0;"><strong>Trigger:</strong> ${escapeHtml(reason)}</p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:12px 0;" />
      <p style="margin:4px 0;"><strong>Summary:</strong> ${escapeHtml(summary)}</p>
      <p style="margin:4px 0;"><strong>Root Cause:</strong> ${escapeHtml(rootCause)}</p>
      ${fixes.length ? `<p style="margin:8px 0 4px;"><strong>Suggested Fixes:</strong></p><ul>${fixes.map(f => `<li>${escapeHtml(typeof f === "string" ? f : f.description || JSON.stringify(f))}</li>`).join("")}</ul>` : ""}
      ${rollback?.shouldRollback ? `<p style="margin:12px 0;padding:8px 12px;background:#fef2f2;border-left:4px solid #dc2626;"><strong>Rollback Recommended:</strong> ${escapeHtml(rollback.reason || "See agent analysis")} (target: <code>${escapeHtml(rollback.targetCommitSha || "previous")}</code>)</p>` : ""}
    </div>
  `.trim();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: config.RESEND_FROM_EMAIL,
        to: [config.DEVELOPER_EMAIL],
        subject,
        text: textLines.join("\n"),
        html
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error(JSON.stringify({ level: "error", event: "resend_email_failed", service: "agent-core", status: res.status, body: errBody.slice(0, 200) }));
      return { attempted: true, sent: false, status: res.status };
    }
    const data = await res.json().catch(() => ({}));
    return { attempted: true, sent: true, id: data.id || null };
  } catch (err) {
    console.error(JSON.stringify({ level: "error", event: "resend_email_error", service: "agent-core", error: err?.message || String(err) }));
    return { attempted: true, sent: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function notifyEngineer(incident, analysis, reason, fetchImpl = globalThis.fetch) {
  const at = new Date().toISOString();
  const hasWebhook = Boolean(config.NOTIFICATION_WEBHOOK_URL);
  const hasResend = Boolean(config.RESEND_API_KEY && config.DEVELOPER_EMAIL);

  const channels = ["log"];
  let webhookOk = true;
  let resendOk = true;

  if (hasWebhook) {
    const text = `[SBWK] Engineer attention needed — ${analysis.severity.toUpperCase()} ${incident.method} ${incident.path} (HTTP ${incident.statusCode}). ${analysis.summary} Root cause: ${analysis.rootCause.summary}. Reason: ${reason}. Incident ${incident.id}.`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(config.NOTIFICATION_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, incidentId: incident.id, severity: analysis.severity, summary: analysis.summary, rootCause: analysis.rootCause, suggestedFixes: analysis.suggestedFixes, reason }),
        signal: controller.signal
      });
      webhookOk = res.ok;
      if (webhookOk) channels.push("webhook");
    } catch {
      webhookOk = false;
    } finally {
      clearTimeout(timeout);
    }
  }

  if (hasResend) {
    const emailRes = await sendResendEmail(incident, analysis, reason, fetchImpl);
    resendOk = emailRes.sent;
    if (resendOk) channels.push("resend");
  }

  const channel = channels.join("+");
  console.log(JSON.stringify({ level: "warn", event: "engineer_notification", service: "agent-core", timestamp: at, incidentId: incident.id, severity: analysis.severity, reason, summary: analysis.summary, channel }));

  return {
    sent: (!hasWebhook || webhookOk) && (!hasResend || resendOk),
    channel,
    reason,
    at
  };
}
