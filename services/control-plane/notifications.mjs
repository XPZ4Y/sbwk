// Control-plane <-> agent-core bridge for fault email notification settings,
// Resend API token verification, and operability test emails.
// The browser never sees agent-core's bearer token or stored Resend API key.
import { config } from "./config.mjs";

const auth = () => ({ Authorization: `Bearer ${config.AGENT_CORE_TOKEN}` });

async function request(path, { method = "GET", body, timeoutMs } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs || config.REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.AGENT_CORE_URL}${path}`, {
      method,
      headers: { ...auth(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      redirect: "manual"
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      return { ok: false, status: res.status, error: data?.error?.message || data?.error || `agent-core HTTP ${res.status}`, data };
    }
    return { ok: true, status: res.status, data };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: e.name === "AbortError" ? "agent-core timeout" : (e.cause?.code || e.message || "agent-core unreachable")
    };
  } finally {
    clearTimeout(t);
  }
}

export async function getNotificationStatus() {
  const r = await request("/notifications/status");
  if (!r.ok) return { ok: false, status: r.status, error: r.error };
  return { ok: true, notifications: r.data?.notifications || null };
}

export async function saveNotificationConfig(input = {}) {
  if (!input || typeof input !== "object") return { ok: false, status: 400, error: "invalid payload" };
  const notifications = {};
  for (const k of ["resendApiKey", "developerEmail", "fromEmail", "webhookUrl"]) {
    if (typeof input[k] === "string") notifications[k] = input[k];
  }
  if (typeof input.notifyAllIncidents === "boolean") notifications.notifyAllIncidents = input.notifyAllIncidents;
  for (const k of ["timeoutMs", "maxRetries"]) {
    if (typeof input[k] === "number" && Number.isFinite(input[k])) notifications[k] = input[k];
  }
  if (!Object.keys(notifications).length) return { ok: false, status: 400, error: "nothing to update" };

  const r = await request("/config", { method: "POST", body: { notifications } });
  if (!r.ok) return { ok: false, status: r.status, error: r.error };
  return { ok: true, notifications: r.data?.config?.notifications || null };
}

function pickProbeFields(input = {}) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  for (const k of ["resendApiKey", "developerEmail", "fromEmail", "reason"]) {
    if (typeof input[k] === "string" && input[k].trim()) out[k] = input[k].trim();
  }
  return out;
}

export async function verifyNotifications(input = {}) {
  const r = await request("/notifications/verify", {
    method: "POST",
    body: pickProbeFields(input),
    timeoutMs: 15000
  });
  if (!r.ok) return { ok: false, status: r.status, error: r.error };
  return { ok: true, verification: r.data?.verification || null };
}

export async function sendTestNotification(input = {}) {
  const r = await request("/notifications/test", {
    method: "POST",
    body: pickProbeFields(input),
    timeoutMs: 25000
  });
  if (!r.ok) return { ok: false, status: r.status, error: r.error };
  return { ok: true, result: r.data?.result || null };
}
