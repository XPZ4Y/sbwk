// Push configuration to the running services over HTTP. Every call returns a
// result object and never throws, so one failing service cannot break a save.
import { config } from "./config.mjs";
import { buildConnectorSlots } from "./external.mjs";

async function post(url, token, body) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), config.REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "manual"
    });
    await res.body?.cancel().catch(() => {});
    return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "timeout" : (e.cause?.code || e.message || "unreachable") };
  } finally { clearTimeout(t); }
}

export function applyGateway(state) {
  return post(`${config.MIDDLEWARE_URL}/_sbwk/config`, config.MIDDLEWARE_ADMIN_TOKEN, { targetServerUrl: state.gateway.targetUrl });
}

export function applyExternal(state) {
  const { slots, skipped } = buildConnectorSlots(state.external.services);
  // Always push, even an empty map, so removing a service also clears it at the connector.
  // ASSUMPTION to verify: the connector treats this as a full replace, not a merge.
  return post(`${config.CONNECTOR_URL}/connector/config`, config.CONNECTOR_API_TOKEN, { services: slots })
    .then(r => (skipped.length ? { ...r, skipped } : r));
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
  const targets = {
    middleware: `${config.MIDDLEWARE_URL}/health`,
    agentCore: `${config.AGENT_CORE_URL}/health`,
    connector: `${config.CONNECTOR_URL}/health`
  };
  const out = {};
  await Promise.all(Object.entries(targets).map(async ([name, url]) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: "manual" });
      await res.body?.cancel().catch(() => {});
      out[name] = res.ok ? "healthy" : `http ${res.status}`;
    } catch { out[name] = "unreachable"; }
    finally { clearTimeout(t); }
  }));
  return out;
}
