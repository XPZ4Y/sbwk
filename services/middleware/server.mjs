// Zero-dependency SBWK edge middleware: native node:http reverse proxy +
// anomaly detection (status, slow responses, upstream failures) + fire-and-forget
// dispatch to Agent Core + full request log ring buffer.
import http from "node:http";
import https from "node:https";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { config } from "./config.mjs";
import { classifyStatus, categoryForUpstreamError, buildIncident, DispatchThrottle } from "./detector.mjs";
import { LogBatchBuffer } from "./batch-buffer.mjs";

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

// Ring buffer for all passing client -> server requests.
const MAX_REQUEST_LOGS = 500;
const requestLogs = [];
function logRequestAdd(entry) {
  requestLogs.push(entry);
  if (requestLogs.length > MAX_REQUEST_LOGS) requestLogs.shift();
  return entry;
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
  // Batch mode: buffer instead of paging. Nothing AI-shaped happens here — the
  // buffer only wakes Agent Core once a pattern of bad requests has formed.
  if (config.DETECT_MODE === "batch" && dispatch) {
    const { flush } = batch.add(incident);
    // `dispatched` keeps its existing meaning (throttle let it through); the
    // additive `batched` flag says it went to the buffer instead of the wire.
    entry.batched = true;
    entry.dispatched = false;
    if (flush) flush.catch(() => {});
  } else if (dispatch) {
    dispatchIncident(incident).then(ok => { entry.dispatchOk = ok; });
  }
  return incident.id;
}

// ---------------------------------------------------------------------------
// Stage one of the two-stage gate: buffer bad requests, never per-request.
// In `batch` mode the middleware sends Agent Core ONE compact batch (digest +
// raw incidents). Agent Core asks Liquid d1 whether the pattern is worth a Groq
// call and answers with `{ action: "investigate" | "skip", ... }`.
//
// If the whole batch endpoint is unreachable, LIQUID_BATCH_FALLBACK decides:
// "investigate" (default) replays the incidents through the existing
// per-incident dispatchIncident path — the real agent path — so a broken batch
// never silently drops signal; "skip" accepts the miss and logs it loudly.
// ---------------------------------------------------------------------------
let lastBatch = null;

async function sendBatch(payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.BATCH_TIMEOUT_MS);
  try {
    const res = await fetch(new URL("/incidents/batch", config.AGENT_CORE_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.AGENT_CORE_TOKEN}` },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 500) }; }
    if (!res.ok || json.success === false) {
      log("warn", "batch_dispatch_rejected", { batchId: payload.batchId, status: res.status });
      return { ok: false, retryable: res.status >= 500, status: res.status, body: json };
    }
    log("info", "batch_dispatched", { batchId: payload.batchId, count: payload.incidents?.length || 0, action: json.batch?.action ?? null });
    return { ok: true, status: res.status, body: json };
  } catch (e) {
    log("warn", "batch_dispatch_failed", { batchId: payload.batchId, error: e?.message || String(e) });
    return { ok: false, retryable: true, error: e?.message || String(e) };
  } finally { clearTimeout(timeout); }
}

const batch = new LogBatchBuffer({
  mode: config.DETECT_MODE,
  minBad: config.BATCH_MIN_BAD,
  windowMs: config.BATCH_WINDOW_MS,
  maxSize: config.BATCH_MAX_SIZE,
  flushTimeoutMs: config.BATCH_FLUSH_TIMEOUT_MS,
  sweepMs: config.BATCH_SWEEP_MS,
  // Dumb activation rules: one severe event may self-activate; known noise may
  // self-answer without a model call.
  impulse: config.BATCH_IMPULSE,
  impulseSevereMs: config.BATCH_IMPULSE_SEVERE_MS,
  skipTrivial: config.BATCH_SKIP_TRIVIAL,
  onFlush: async ({ incidents, digest, meta }) => {
    const payload = {
      batchId: meta.batchId,
      batch: {
        reason: meta.reason, minBad: meta.minBad, windowMs: meta.windowMs,
        dropped: meta.dropped, expired: meta.expired,
        // Set when the buffer already knows the batch is pure noise.
        ...(meta.trivial ? { trivial: true, trivialReason: meta.trivialReason, trivialCode: meta.trivialCode, trivialByCode: meta.trivialByCode } : {})
      },
      digest,
      incidents
    };
    const sent = await sendBatch(payload);
    const fallback = config.LIQUID_BATCH_FALLBACK;
    const outcome = { batchId: meta.batchId, ...sent, fallback };

    if (!sent.ok) {
      outcome.fallbackAttempted = 0;
      outcome.fallbackDispatched = 0;
      if (fallback === "investigate") {
        // The "actual agent" path: behave exactly as immediate mode would have.
        log("warn", "batch_fallback_investigate", { batchId: meta.batchId, count: incidents.length, reason: sent.error || `HTTP ${sent.status}` });
        outcome.fallbackAttempted = incidents.length;
        const results = await Promise.all(incidents.map(i => dispatchIncident(i)));
        outcome.fallbackDispatched = results.filter(Boolean).length;
      } else {
        log("error", "batch_fallback_skip", { batchId: meta.batchId, count: incidents.length, reason: sent.error || `HTTP ${sent.status}` });
      }
    } else {
      const gateResult = sent.body?.batch || {};
      outcome.action = gateResult.action ?? null;
      outcome.reason = gateResult.reason ?? null;
      outcome.liquidFallback = gateResult.fallback ?? null;
      outcome.investigated = Array.isArray(gateResult.investigated) ? gateResult.investigated.length : null;
      outcome.skipped = Array.isArray(gateResult.skipped) ? gateResult.skipped.length : null;
    }
    lastBatch = { ...outcome, at: new Date().toISOString(), count: incidents.length };
    return outcome;
  }
});
if (batch.enabled) batch.start();

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
    return sendJson(res, 200, { success: true, service: "middleware", target: config.TARGET_SERVER_URL, agentCore: config.AGENT_CORE_URL, detection: { minStatus: config.DETECT_STATUS_MIN, slowMs: config.DETECT_SLOW_MS, upstreamErrors: config.DETECT_UPSTREAM_ERRORS, cooldownMs: config.DISPATCH_COOLDOWN_MS }, mode: config.DETECT_MODE, batch: { ...batch.stats(), fallback: config.LIQUID_BATCH_FALLBACK, timeoutMs: config.BATCH_TIMEOUT_MS, last: lastBatch }, incidents: storeCounts(), totalRequests: requestLogs.length });
  }
  if (url.pathname === "/_sbwk/batch" && req.method === "GET") {
    return sendJson(res, 200, { success: true, batch: batch.stats(), last: lastBatch });
  }
  // Force a flush of whatever is buffered (demo/debug aid; no-op in immediate mode).
  if (url.pathname === "/_sbwk/batch/flush" && req.method === "POST") {
    const result = await batch.flush("manual");
    return sendJson(res, 200, { success: true, batch: batch.stats(), result });
  }
  if (url.pathname === "/_sbwk/incidents") {
    const limit = Math.min(Number(url.searchParams.get("limit")) || 50, config.MAX_RECENT_INCIDENTS);
    return sendJson(res, 200, { success: true, incidents: recent.slice(-limit).reverse() });
  }
  if (url.pathname === "/_sbwk/logs" && req.method === "GET") {
    const limit = Math.min(Number(url.searchParams.get("limit")) || 100, MAX_REQUEST_LOGS);
    return sendJson(res, 200, { success: true, logs: requestLogs.slice(-limit).reverse() });
  }
  if (url.pathname === "/_sbwk/logs" && req.method === "DELETE") {
    requestLogs.length = 0;
    return sendJson(res, 200, { success: true, logs: [] });
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
      const durationMs = Math.round(elapsed() * 100) / 100;
      let decision = statusDecision;
      if (!decision.detect && config.DETECT_SLOW_MS > 0 && durationMs > config.DETECT_SLOW_MS) {
        decision = { detect: true, category: "slow_response", reason: `Response took ${Math.round(durationMs)}ms (threshold ${config.DETECT_SLOW_MS}ms)` };
      }
      const sample = max > 0 ? Buffer.concat(chunks).subarray(0, 512).toString("utf8") : undefined;
      let incidentId = null;
      if (decision.detect) {
        incidentId = recordAndDispatch(buildIncident({
          id: randomUUID(), requestId, method: req.method, url: req.url, statusCode: status, durationMs,
          upstream: config.TARGET_SERVER_URL, category: decision.category, reason: decision.reason,
          responseSample: sample, clientIp: clientIp(req), userAgent: req.headers["user-agent"]
        }));
      }
      logRequestAdd({
        id: requestId,
        timestamp: new Date().toISOString(),
        method: req.method,
        path: req.url,
        statusCode: status,
        durationMs,
        upstream: config.TARGET_SERVER_URL,
        clientIp: clientIp(req),
        anomaly: decision.detect,
        category: decision.detect ? decision.category : "normal",
        incidentId,
        responseSample: sample
      });
      log("info", "http_request_proxied", { requestId, method: req.method, path: req.url, statusCode: status, durationMs, anomaly: decision.detect });
    });
  });

  proxyReq.setTimeout(config.PROXY_TIMEOUT_MS, () => { const e = new Error("Upstream request timed out"); e.code = "ETIMEDOUT"; proxyReq.destroy(e); });

  proxyReq.on("error", err => {
    const isTimeout = err.code === "ETIMEDOUT" || err.code === "ESOCKETTIMEDOUT" || /timeout/i.test(err.message);
    const status = isTimeout ? 504 : 502;
    const durationMs = Math.round(elapsed() * 100) / 100;
    log("error", "upstream_error", { requestId, method: req.method, path: req.url, code: err.code || "CONNECTION_FAILED", message: err.message });
    if (!res.headersSent) sendJson(res, status, { success: false, error: { code: isTimeout ? "GATEWAY_TIMEOUT" : "BAD_GATEWAY", message: "Upstream server is unavailable" } });
    else res.end();
    let incidentId = null;
    const category = categoryForUpstreamError(isTimeout ? "TIMEOUT" : "CONNECTION_FAILED");
    if (config.DETECT_UPSTREAM_ERRORS) {
      incidentId = recordAndDispatch(buildIncident({
        id: randomUUID(), requestId, method: req.method, url: req.url, statusCode: status, durationMs,
        upstream: config.TARGET_SERVER_URL, category,
        reason: isTimeout ? "Upstream server timed out" : "Upstream server could not be reached",
        clientIp: clientIp(req), userAgent: req.headers["user-agent"], error: { code: err.code || "CONNECTION_FAILED", message: err.message }
      }));
    }
    logRequestAdd({
      id: requestId,
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.url,
      statusCode: status,
      durationMs,
      upstream: config.TARGET_SERVER_URL,
      clientIp: clientIp(req),
      anomaly: Boolean(config.DETECT_UPSTREAM_ERRORS),
      category,
      incidentId,
      responseSample: err.message
    });
  });

  req.pipe(proxyReq);
});

server.listen(config.PORT, () => log("info", "middleware_listening", { port: config.PORT, target: config.TARGET_SERVER_URL, agentCore: config.AGENT_CORE_URL, detectStatusMin: config.DETECT_STATUS_MIN, detectSlowMs: config.DETECT_SLOW_MS, detectMode: config.DETECT_MODE, batch: { minBad: config.BATCH_MIN_BAD, windowMs: config.BATCH_WINDOW_MS, maxSize: config.BATCH_MAX_SIZE, fallback: config.LIQUID_BATCH_FALLBACK } }));

function shutdown(signal) { log("info", "middleware_shutdown", { signal }); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10000).unref(); }
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
