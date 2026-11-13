// Pure rules for external services: normalisation, validation, connector mapping.
// No I/O in this file, so every rule is unit-tested in test/external.test.mjs.

export const SERVICE_KINDS = ["auth", "database", "external_api", "other"];
export const CONNECTOR_KINDS = ["auth", "database", "external_api"];
export const MAX_SERVICES = 20;
const ID_RE = /^svc_[A-Za-z0-9_-]{1,40}$/;

export function inferScheme(endpoint) {
  let u;
  try { u = new URL(endpoint); } catch { return "invalid"; }
  switch (u.protocol) {
    case "http:": return "http";
    case "https:": return "https";
    case "mongodb+srv:": return "mongodb+srv";
    case "mongodb:": return "mongodb";
    case "postgres:":
    case "postgresql:": return "postgres";
    case "redis:":
    case "rediss:": return "redis";
    default: return "other";
  }
}

export const isLoopbackHost = host =>
  host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".local");

const originOf = endpoint => { try { return new URL(endpoint).origin; } catch { return null; } };

let idCounter = 0;
export const newServiceId = () => `svc_${Date.now().toString(36)}${(idCounter++).toString(36)}`;

// Merge client-submitted services into the stored list.
//  - A blank token keeps the stored one. Tokens never go back to the client.
//  - If the origin changes and no new token is typed, the token is dropped, so a
//    credential is never sent to a host it was not entered for.
//  - lastCheck survives only while the exact endpoint is unchanged.
export function mergeServices(incoming, stored) {
  const byId = new Map(stored.map(s => [s.id, s]));
  const used = new Set();
  return incoming.slice(0, MAX_SERVICES).map(raw => {
    const wanted = typeof raw.id === "string" && ID_RE.test(raw.id) ? raw.id : null;
    const id = wanted && byId.has(wanted) && !used.has(wanted) ? wanted : newServiceId();
    used.add(id);
    const prev = byId.get(id);
    const endpoint = String(raw.endpoint ?? "").trim();
    const kind = SERVICE_KINDS.includes(raw.kind) ? raw.kind : "other";
    const name = String(raw.name ?? "").trim().slice(0, 64) || kind;
    const typed = typeof raw.token === "string" && raw.token.length > 0 ? raw.token : null;
    const sameOrigin = Boolean(prev) && originOf(prev.endpoint) === originOf(endpoint);
    let token = sameOrigin ? prev.token || "" : "";
    if (raw.clearToken === true) token = "";
    if (typed) token = typed;
    const sameEndpoint = sameOrigin && prev.endpoint === endpoint;
    return { id, name, kind, endpoint, token, lastCheck: sameEndpoint ? prev.lastCheck ?? null : null };
  });
}

// Services that the connector can actually diagnose: HTTP(S) and a known kind.
// Everything else is stored and reported, never silently dropped.
export function buildConnectorSlots(services) {
  const slots = {};
  const skipped = [];
  for (const svc of services) {
    const scheme = inferScheme(svc.endpoint);
    if (scheme !== "http" && scheme !== "https") { skipped.push(`${svc.name}: ${scheme} is not monitored`); continue; }
    if (!CONNECTOR_KINDS.includes(svc.kind)) { skipped.push(`${svc.name}: kind "${svc.kind}" has no connector slot`); continue; }
    if (slots[svc.kind]) { skipped.push(`${svc.name}: a ${svc.kind} service is already monitored`); continue; }
    const u = new URL(svc.endpoint);
    slots[svc.kind] = { baseUrl: u.origin, paths: { logs: u.pathname || "/logs" }, ...(svc.token ? { token: svc.token } : {}) };
  }
  return { slots, skipped };
}

// Validation over the prospective (not yet saved) state.
// severity "error" blocks the save; "warn" is shown but allows it.
export function validateConfig(next) {
  const w = [];
  const err = (field, message) => w.push({ field, severity: "error", message });
  const warn = (field, message) => w.push({ field, severity: "warn", message });

  const target = next.gateway?.targetUrl ?? "";
  if (!target) err("gateway.targetUrl", "TARGET_URL is required.");
  else {
    let u = null;
    try { u = new URL(target); } catch { err("gateway.targetUrl", "TARGET_URL is not a valid URL."); }
    if (u && u.protocol !== "http:" && u.protocol !== "https:") err("gateway.targetUrl", "TARGET_URL must be http or https.");
    else if (u && u.protocol === "http:" && !isLoopbackHost(u.hostname)) warn("gateway.targetUrl", "http:// target: traffic between edge and server is unencrypted.");
  }

  const port = next.gateway?.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) err("gateway.port", "EDGE_PORT must be an integer from 1 to 65535.");

  for (const k of ["dryRun", "autoRollback"]) {
    if (typeof next.safety?.[k] !== "boolean") err(`safety.${k}`, `${k} must be true or false.`);
  }
  const th = next.safety?.escalationThreshold;
  if (typeof th !== "number" || !(th >= 0 && th <= 1)) err("safety.escalationThreshold", "Escalation threshold must be between 0% and 100%.");
  else if (th === 0) warn("safety.escalationThreshold", "At 0% the agent never escalates to a human.");

  const monitoredKinds = new Map();
  (next.external?.services || []).forEach((svc, i) => {
    const f = `external.services[${i}]`;
    const label = svc.name || svc.kind;
    if (!svc.endpoint) { err(`${f}.endpoint`, `${label}: endpoint is required.`); return; }
    const scheme = inferScheme(svc.endpoint);
    if (scheme === "invalid") { err(`${f}.endpoint`, `${label}: not a valid URL.`); return; }
    if (scheme === "other") warn(`${f}.endpoint`, `${label}: unrecognised scheme, stored but not monitored.`);
    else if (scheme !== "http" && scheme !== "https") warn(`${f}.endpoint`, `${label}: ${scheme} is checked by DNS only; the connector will not monitor it.`);
    else if (scheme === "http" && !isLoopbackHost(new URL(svc.endpoint).hostname)) warn(`${f}.endpoint`, `${label}: plaintext http://, so credentials sent to it are unencrypted.`);

    if (!CONNECTOR_KINDS.includes(svc.kind)) warn(`${f}.kind`, `${label}: kind "${svc.kind}" has no connector slot, so it is stored only.`);
    else if (scheme === "http" || scheme === "https") {
      if (monitoredKinds.has(svc.kind)) warn(`${f}.kind`, `${label}: ${monitoredKinds.get(svc.kind)} already monitors ${svc.kind}; this one is stored only.`);
      else monitoredKinds.set(svc.kind, label);
    }
  });
  return w;
}
