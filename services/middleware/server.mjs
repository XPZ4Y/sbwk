// Zero-dependency SBWK edge middleware: native node:http reverse proxy +
// anomaly detection (status, slow responses, upstream failures) + fire-and-forget
// dispatch to Agent Core. Target/detection are runtime-configurable by the control plane.
import http from "node:http";
import https from "node:https";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { config } from "./config.mjs";
import { classifyStatus, categoryForUpstreamError, buildIncident, DispatchThrottle } from "./detector.mjs";

const log = (level, event, fields = {}) =>
  console.log(JSON.stringify({ level, event, service: "middleware", timestamp: new Date().toISOString(), ...fields }));

const throttle = new DispatchThrottle(config.DISPATCH_COOLDOWN_MS);

// Resolve the proxy target per request so onboarding can re-point it live.
function resolveTarget() {
  const t = new URL(config.TARGET_SERVER_URL);
  return { url: t, lib: t.protocol === "https:" ? https : http, port: Number(t.port) || (t.protocol === "https:" ? 443 : 80) };
}

const recent = [];
function storeAdd(entry) { recent.push(entry); if (recent.length > config.MAX_RECENT_INCIDENTS) recent.shift(); return entry; }
function storeCounts() {
  const byCategory = {};
  for (const r of recent) byCategory[r.incident.category] = (byCategory[r.incident.category] || 0) + 1;
  return { total: recent.length, dispatched: recent.filter(r => r.dispatched).length, byCategory };
}

async function dispatchIncident(incident) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.DISPATCH_TIMEOUT_MS);
  try {
    const res = await fetch(new URL("/incidents", config.AGENT_CORE_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.AGENT_CORE_TOKEN}`, "X-Request-Id": incident.requestId },
      body: JSON.stringify(incident), signal: controller.signal
    });
    log(res.ok ? "info" : "warn", res.ok ? "incident_dispatched" : "incident_dispatch_rejected", { incidentId: incident.id, status: res.status });
    return res.ok;
  } catch {
    log("warn", "incident_dispatch_failed", { incidentId: incident.id });
    return false;
  } finally { clearTimeout(timeout); }
}

function recordAndDispatch(incident) {
  const dispatch = throttle.shouldDispatch(incident);
  const entry = storeAdd({ incident, dispatched: dispatch });
  log("warn", "anomaly_detected", { incidentId: incident.id, requestId: incident.requestId, method: incident.method, path: incident.path, statusCode: incident.statusCode, category: incident.category, dispatched: dispatch });
  if (dispatch) dispatchIncident(incident).then(ok => { entry.dispatchOk = ok; });
}

function sendJson(res, status, obj) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }

function adminAuthed(req) {
  if (config.NODE_ENV === "test") return true;
  const h = req.headers["authorization"] || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const expected = config.MIDDLEWARE_ADMIN_TOKEN;
  return token.length === expected.length && timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress;
}

function readJson(req, limit = 32768) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new Error("invalid JSON")); } });
    req.on("error", reject);
  });
}

async function handleAdmin(req, res, url) {
  if (!adminAuthed(req)) return sendJson(res, 401, { success: false, error: { code: "UNAUTHORIZED", message: "Valid middleware admin bearer token required" } });

  if (url.pathname === "/_sbwk/status") {
    return sendJson(res, 200, { success: true, service: "middleware", target: config.TARGET_SERVER_URL, agentCore: config.AGENT_CORE_URL, detection: { minStatus: config.DETECT_STATUS_MIN, slowMs: config.DETECT_SLOW_MS, upstreamErrors: config.DETECT_UPSTREAM_ERRORS, cooldownMs: config.DISPATCH_COOLDOWN_MS }, incidents: storeCounts() });
  }
  if (url.pathname === "/_sbwk/incidents") {
    const limit = Math.min(Number(url.searchParams.get("limit")) || 50, config.MAX_RECENT_INCIDENTS);
    return sendJson(res, 200, { success: true, incidents: recent.slice(-limit).reverse() });
  }
  // Runtime configuration from the control plane (onboarding Step 01).
  if (url.pathname === "/_sbwk/config" && req.method === "POST") {
    const body = await readJson(req);
    if (typeof body.targetServerUrl === "string" && body.targetServerUrl) {
      try { new URL(body.targetServerUrl); config.TARGET_SERVER_URL = body.targetServerUrl; }
      catch { return sendJson(res, 400, { success: false, error: { code: "VALIDATION_ERROR", message: "targetServerUrl must be a valid URL" } }); }
    }
    if (Number.isFinite(Number(body.detectStatusMin))) config.DETECT_STATUS_MIN = Number(body.detectStatusMin);
    if (Number.isFinite(Number(body.detectSlowMs))) config.DETECT_SLOW_MS = Number(body.detectSlowMs);
    log("info", "middleware_config_updated", { target: config.TARGET_SERVER_URL, minStatus: config.DETECT_STATUS_MIN, slowMs: config.DETECT_SLOW_MS });
    return sendJson(res, 200, { success: true, target: config.TARGET_SERVER_URL, detection: { minStatus: config.DETECT_STATUS_MIN, slowMs: config.DETECT_SLOW_MS } });
  }
  return sendJson(res, 404, { success: false, error: { code: "NOT_FOUND", message: "Route not found" } });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const incoming = req.headers["x-request-id"];
  const requestId = incoming && /^[a-zA-Z0-9._:-]{1,100}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader("X-Request-Id", requestId);
  const start = process.hrtime.bigint();
  const elapsed = () => Number(process.hrtime.bigint() - start) / 1e6;

  if (url.pathname === "/health" && req.method === "GET") return sendJson(res, 200, { success: true, service: "middleware", status: "healthy" });
  if (url.pathname.startsWith("/_sbwk/")) return void handleAdmin(req, res, url).catch(e => sendJson(res, 400, { success: false, error: { code: "BAD_REQUEST", message: e.message } }));

  const target = resolveTarget();
  const headers = { ...req.headers, host: target.url.host, "x-forwarded-for": clientIp(req), "x-forwarded-proto": "http", "x-request-id": requestId };
  const proxyReq = target.lib.request({ protocol: target.url.protocol, hostname: target.url.hostname, port: target.port, path: req.url, method: req.method, headers }, proxyRes => {
    const status = proxyRes.statusCode || 0;
    const statusDecision = classifyStatus(status, config.DETECT_STATUS_MIN);
    res.writeHead(status, proxyRes.headers);
    proxyRes.pipe(res);

    const max = config.RESPONSE_SAMPLE_BYTES;
    const chunks = []; let size = 0;
    proxyRes.on("data", c => { if (size < max) { chunks.push(c); size += c.length; } });
    proxyRes.on("end", () => {
      const durationMs = elapsed();
      let decision = statusDecision;
      if (!decision.detect && config.DETECT_SLOW_MS > 0 && durationMs > config.DETECT_SLOW_MS) {
        decision = { detect: true, category: "slow_response", reason: `Response took ${Math.round(durationMs)}ms (threshold ${config.DETECT_SLOW_MS}ms)` };
      }
      log("info", "http_request_proxied", { requestId, method: req.method, path: req.url, statusCode: status, durationMs: Math.round(durationMs * 100) / 100, anomaly: decision.detect });
      if (decision.detect) {
        const sample = max > 0 && decision.category !== "slow_response" ? Buffer.concat(chunks).subarray(0, max).toString("utf8") : undefined;
        recordAndDispatch(buildIncident({
          id: randomUUID(), requestId, method: req.method, url: req.url, statusCode: status, durationMs,
          upstream: config.TARGET_SERVER_URL, category: decision.category, reason: decision.reason,
          responseSample: sample, clientIp: clientIp(req), userAgent: req.headers["user-agent"]
        }));
      }
    });
  });

  proxyReq.setTimeout(config.PROXY_TIMEOUT_MS, () => { const e = new Error("Upstream request timed out"); e.code = "ETIMEDOUT"; proxyReq.destroy(e); });

  proxyReq.on("error", err => {
    const isTimeout = err.code === "ETIMEDOUT" || err.code === "ESOCKETTIMEDOUT" || /timeout/i.test(err.message);
    const status = isTimeout ? 504 : 502;
    log("error", "upstream_error", { requestId, method: req.method, path: req.url, code: err.code || "CONNECTION_FAILED", message: err.message });
    if (!res.headersSent) sendJson(res, status, { success: false, error: { code: isTimeout ? "GATEWAY_TIMEOUT" : "BAD_GATEWAY", message: "Upstream server is unavailable" } });
    else res.end();
    if (config.DETECT_UPSTREAM_ERRORS) {
      recordAndDispatch(buildIncident({
        id: randomUUID(), requestId, method: req.method, url: req.url, statusCode: status, durationMs: elapsed(),
        upstream: config.TARGET_SERVER_URL, category: categoryForUpstreamError(isTimeout ? "TIMEOUT" : "CONNECTION_FAILED"),
        reason: isTimeout ? "Upstream server timed out" : "Upstream server could not be reached",
        clientIp: clientIp(req), userAgent: req.headers["user-agent"], error: { code: err.code || "CONNECTION_FAILED", message: err.message }
      }));
    }
  });

  req.pipe(proxyReq);
});

server.listen(config.PORT, () => log("info", "middleware_listening", { port: config.PORT, target: config.TARGET_SERVER_URL, agentCore: config.AGENT_CORE_URL, detectStatusMin: config.DETECT_STATUS_MIN, detectSlowMs: config.DETECT_SLOW_MS }));

function shutdown(signal) { log("info", "middleware_shutdown", { signal }); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10000).unref(); }
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
