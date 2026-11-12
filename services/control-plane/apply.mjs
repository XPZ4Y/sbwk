// Push onboarding configuration to the running services (real, over HTTP).
import { config } from "./config.mjs";

async function post(url, token, body) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), config.REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: controller.signal });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "timeout" : (e.message || "unreachable") };
  } finally { clearTimeout(t); }
}

export function applyGateway(state) {
  return post(`${config.MIDDLEWARE_URL}/_sbwk/config`, config.MIDDLEWARE_ADMIN_TOKEN, { targetServerUrl: state.gateway.targetUrl });
}

export function applyExternal(state) {
  // Map HTTP endpoints to the connector's live integration. Non-HTTP (e.g. mongodb+srv)
  // is stored but not pushed — the connector's live diagnostics are HTTP-based.
  const services = {};
  const map = (endpoint) => {
    try { const u = new URL(endpoint); if (u.protocol === "http:" || u.protocol === "https:") return { baseUrl: u.origin, paths: { logs: u.pathname || "/logs" } }; } catch { /* ignore */ }
    return null;
  };
  const auth = map(state.external.authEndpoint);
  if (auth) services.auth = { ...auth, token: state.external.apiKey || undefined };
  const db = map(state.external.databaseEndpoint);
  if (db) services.database = db;
  if (!Object.keys(services).length) return Promise.resolve({ ok: true, skipped: "no HTTP endpoints to push (stored for future driver-based integration)" });
  return post(`${config.CONNECTOR_URL}/connector/config`, config.CONNECTOR_API_TOKEN, { services });
}

export function applyCodebase(state) {
  return post(`${config.AGENT_CORE_URL}/config`, config.AGENT_CORE_TOKEN, {
    codebase: { repoUrl: state.codebase.repoUrl, fullName: state.codebase.fullName, commits: state.codebase.commits }
  });
}

export function applySafety(state) {
  return post(`${config.AGENT_CORE_URL}/config`, config.AGENT_CORE_TOKEN, {
    dryRun: state.safety.dryRun, autoRollback: state.safety.autoRollback, escalationThreshold: state.safety.escalationThreshold
  });
}

export function applyMonitoring(active) {
  return post(`${config.AGENT_CORE_URL}/config`, config.AGENT_CORE_TOKEN, { monitoringActive: active });
}

export async function serviceHealth() {
  const targets = { middleware: `${config.MIDDLEWARE_URL}/health`, agentCore: `${config.AGENT_CORE_URL}/health`, connector: `${config.CONNECTOR_URL}/health` };
  const out = {};
  await Promise.all(Object.entries(targets).map(async ([name, url]) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    try { const res = await fetch(url, { signal: controller.signal }); out[name] = res.ok ? "healthy" : `http ${res.status}`; }
    catch { out[name] = "unreachable"; }
    finally { clearTimeout(t); }
  }));
  return out;
}
