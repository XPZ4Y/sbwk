// Atomic configuration save. Everything is validated first. If anything blocks,
// nothing is persisted and nothing is pushed. Otherwise the state is persisted once,
// then each downstream is pushed and its result reported. A failed push does not
// roll back the saved config; it is reported as `partial` so the operator can act.
import { config } from "./config.mjs";
import * as store from "./store.mjs";
import { MAX_SERVICES, mergeServices, validateConfig } from "./external.mjs";
import { checkReachability, fetchGitHubRepo } from "./checks.mjs";
import { applyGateway, applyExternal, applyCodebase, applySafety, applyMonitoring } from "./apply.mjs";

const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
const bad = (field, message) => ({ field, severity: "error", message });

// Builds the state that would exist after this save, without touching the store.
function prospective(body, current) {
  const next = structuredClone({
    gateway: current.gateway, external: current.external, codebase: current.codebase,
    safety: current.safety, monitoring: current.monitoring
  });
  const errors = [];
  let repo = null; // { url, token } when GitHub must be queried

  if (body.gateway !== undefined) {
    if (!isObj(body.gateway)) errors.push(bad("gateway", "gateway must be an object"));
    else {
      if (body.gateway.targetUrl !== undefined) next.gateway.targetUrl = String(body.gateway.targetUrl).trim();
      if (body.gateway.port !== undefined) next.gateway.port = Number(body.gateway.port);
    }
  }

  if (body.external !== undefined) {
    const list = isObj(body.external) ? body.external.services : undefined;
    if (!Array.isArray(list)) errors.push(bad("external.services", "services must be a list"));
    else if (!list.every(isObj)) errors.push(bad("external.services", "every service must be an object"));
    else if (list.length > MAX_SERVICES) errors.push(bad("external.services", `at most ${MAX_SERVICES} services are supported`));
    else next.external = { services: mergeServices(list, current.external.services) };
  }

  if (body.codebase !== undefined) {
    if (!isObj(body.codebase)) errors.push(bad("codebase", "codebase must be an object"));
    else {
      const url = String(body.codebase.repoUrl ?? current.codebase.repoUrl).trim();
      const typed = typeof body.codebase.token === "string" && body.codebase.token.length > 0 ? body.codebase.token : null;
      const changed = url !== current.codebase.repoUrl;
      if (!url) {
        next.codebase = { repoUrl: "", fullName: "", defaultBranch: null, token: "", commits: [], connectedAt: null };
      } else {
        // Never carry a token across repositories.
        next.codebase = { ...next.codebase, repoUrl: url, token: changed ? "" : current.codebase.token };
        if (typed) next.codebase.token = typed;
        if (changed || typed) repo = { url, token: typed };
      }
    }
  }

  if (body.monitoring !== undefined) {
    if (!isObj(body.monitoring) || typeof body.monitoring.active !== "boolean") {
      errors.push(bad("monitoring.active", "monitoring.active must be true or false"));
    } else if (body.monitoring.active !== current.monitoring.active) {
      next.monitoring = {
        active: body.monitoring.active,
        startedAt: body.monitoring.active ? new Date().toISOString() : null
      };
    }
  }

  if (body.safety !== undefined) {
    if (!isObj(body.safety)) errors.push(bad("safety", "safety must be an object"));
    else {
      // Types are checked in validateConfig, so "false" as a string is rejected, not coerced.
      const s = body.safety;
      if (s.dryRun !== undefined) next.safety.dryRun = s.dryRun;
      if (s.autoRollback !== undefined) next.safety.autoRollback = s.autoRollback;
      if (s.escalationThreshold !== undefined) next.safety.escalationThreshold = s.escalationThreshold;
    }
  }

  return { next, repo, errors };
}

// Plain GET with a timeout. Returns the status only; the body is discarded.
async function getStatus(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), config.REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: "manual", signal: controller.signal });
    await res.body?.cancel().catch(() => {});
    return { status: res.status };
  } catch (e) {
    return { error: e.name === "AbortError" ? "timed out" : (e.cause?.code || e.message || "unreachable") };
  } finally { clearTimeout(t); }
}

const defaultDeps = { fetchGitHubRepo, checkReachability, applyGateway, applyExternal, applyCodebase, applySafety, applyMonitoring, getStatus };

export async function saveConfig(body, deps = defaultDeps) {
  if (!isObj(body)) return { status: 400, body: { success: false, error: "request body must be a JSON object" } };

  const { next, repo, errors } = prospective(body, store.get());
  const warnings = [...errors, ...validateConfig(next)];

  if (body.save === false) {
    return { status: 200, body: { success: true, validated: true, warnings, state: store.redacted() } };
  }

  const blocking = warnings.filter(w => w.severity === "error");
  if (blocking.length) {
    return { status: 400, body: { success: false, error: blocking[0].message, warnings } };
  }

  if (repo) {
    try {
      const fetched = await deps.fetchGitHubRepo(repo.url, repo.token);
      next.codebase = {
        ...next.codebase,
        repoUrl: fetched.repoUrl,
        fullName: fetched.fullName,
        defaultBranch: fetched.defaultBranch,
        commits: fetched.commits,
        connectedAt: new Date().toISOString()
      };
    } catch (e) {
      return { status: 400, body: { success: false, error: `repository: ${e.message}`, warnings } };
    }
  }

  try {
    store.update({
      gateway: next.gateway, external: next.external, codebase: next.codebase,
      safety: next.safety, monitoring: next.monitoring
    });
  } catch (e) {
    return { status: 500, body: { success: false, error: `could not save: ${e.message}`, warnings } };
  }

  const snap = store.get();
  const applied = {};
  await Promise.all([
    ["gateway", () => deps.applyGateway(snap)],
    ["external", () => deps.applyExternal(snap)],
    ["codebase", () => deps.applyCodebase(snap)],
    ["safety", () => deps.applySafety(snap)],
    ["monitoring", () => deps.applyMonitoring(snap.monitoring.active)]
  ].map(async ([key, fn]) => { applied[key] = await fn(); }));

  const partial = Object.values(applied).some(a => !a.ok);
  return { status: 200, body: { success: true, partial, state: store.redacted(), applied, warnings } };
}

// Probes each saved service. Tokens stay server-side; only results go back.
export async function checkServices(deps = defaultDeps) {
  const probed = store.get().external.services;
  const results = await Promise.all(probed.map(async s => ({
    id: s.id,
    endpoint: s.endpoint,
    lastCheck: { ...(await deps.checkReachability(s.endpoint, { token: s.token })), at: new Date().toISOString() }
  })));
  // Attach results only where the service still has the same endpoint; it may have changed mid-check.
  const services = store.get().external.services.map(s => {
    const r = results.find(x => x.id === s.id && x.endpoint === s.endpoint);
    return r ? { ...s, lastCheck: r.lastCheck } : s;
  });
  store.patch("external", { services });
  return { success: true, state: store.redacted() };
}

// Gateway check. The old check probed the production server directly and called it
// the edge. This one asks the edge itself (its health), then sends one request through
// it and reports what came back. NOTE: that request reaches the real target at "/".
export async function checkGateway(deps = defaultDeps) {
  const edge = await deps.getStatus(`${config.MIDDLEWARE_URL}/health`);
  const through = await deps.getStatus(`${config.MIDDLEWARE_URL}/`);
  const lastCheck = {
    at: new Date().toISOString(),
    edge: edge.status === 200 ? "healthy" : edge.status ? `http ${edge.status}` : `unreachable: ${edge.error}`,
    forwardedStatus: through.status ?? null,
    error: through.error ?? null
  };
  store.patch("gateway", { lastCheck });
  return { success: true, lastCheck, state: store.redacted() };
}
