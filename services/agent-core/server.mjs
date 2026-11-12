// Zero-dependency Agent Core HTTP API.
import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { config, investigateServices } from "./config.mjs";
import { IncidentStore } from "./store.mjs";
import { inspectCodebase } from "./codebase.mjs";
import { reason } from "./reason.mjs";
import { notifyEngineer } from "./notify.mjs";
import { createInvestigator, makeConnectorClient } from "./investigate.mjs";

const log = (level, event, fields = {}) =>
  console.log(JSON.stringify({ level, event, service: "agent-core", timestamp: new Date().toISOString(), ...fields }));

const store = new IncidentStore(config.MAX_CONTEXT_INCIDENTS, config.DATA_DIR);
store.load();
const investigator = createInvestigator({
  store, investigateDependencies: makeConnectorClient(config), inspectCodebase, reason, notifyEngineer, config, services: investigateServices
});

function sendJson(res, status, obj) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }
const err = (res, status, code, message) => sendJson(res, status, { success: false, error: { code, message } });

function readJson(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new Error("invalid JSON")); } });
    req.on("error", reject);
  });
}

function authed(req) {
  if (config.NODE_ENV === "test") return true;
  const h = req.headers["authorization"] || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const expected = config.AGENT_CORE_TOKEN;
  return token.length === expected.length && timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

function publicConfig() {
  return {
    mode: config.AGENT_MODE,
    monitoringActive: config.MONITORING_ACTIVE,
    dryRun: config.DRY_RUN,
    autoRollback: config.AUTO_ROLLBACK,
    escalationThreshold: config.ESCALATION_CONFIDENCE_THRESHOLD,
    connectorUrl: config.CONNECTOR_URL,
    codebasePath: config.CODEBASE_PATH || null,
    codebase: { repoUrl: config.codebase.repoUrl || null, fullName: config.codebase.fullName || null, commitCount: config.codebase.commits.length }
  };
}

function applyConfig(body) {
  if (typeof body.escalationThreshold === "number" && body.escalationThreshold >= 0 && body.escalationThreshold <= 1) config.ESCALATION_CONFIDENCE_THRESHOLD = body.escalationThreshold;
  if (typeof body.dryRun === "boolean") config.DRY_RUN = body.dryRun;
  if (typeof body.autoRollback === "boolean") config.AUTO_ROLLBACK = body.autoRollback;
  if (typeof body.monitoringActive === "boolean") config.MONITORING_ACTIVE = body.monitoringActive;
  if (body.codebase && typeof body.codebase === "object") {
    if (typeof body.codebase.repoUrl === "string") config.codebase.repoUrl = body.codebase.repoUrl || undefined;
    if (typeof body.codebase.fullName === "string") config.codebase.fullName = body.codebase.fullName || undefined;
    if (Array.isArray(body.codebase.commits)) config.codebase.commits = body.codebase.commits.slice(0, 5);
  }
  log("info", "agent_core_config_updated", publicConfig());
}

function validateIncident(b) {
  if (!b || typeof b !== "object") return "incident must be an object";
  for (const f of ["id", "requestId", "method", "path", "category", "reason", "detectedAt", "upstream"]) {
    if (typeof b[f] !== "string" || !b[f]) return `missing field: ${f}`;
  }
  if (!Number.isInteger(b.statusCode)) return "statusCode must be an integer";
  if (typeof b.durationMs !== "number") return "durationMs must be a number";
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  const incoming = req.headers["x-request-id"];
  const requestId = incoming && /^[a-zA-Z0-9._:-]{1,100}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader("X-Request-Id", requestId);
  const start = process.hrtime.bigint();
  res.on("finish", () => log(res.statusCode >= 500 ? "error" : "info", "http_request_completed", { requestId, method: req.method, path, statusCode: res.statusCode, durationMs: Math.round(Number(process.hrtime.bigint() - start) / 1e6 * 100) / 100 }));

  try {
    if (path === "/health" && req.method === "GET") return sendJson(res, 200, { success: true, service: "agent-core", status: "healthy", mode: config.AGENT_MODE, monitoringActive: config.MONITORING_ACTIVE });

    // Runtime configuration from the control plane (onboarding Steps 03 + 04).
    if (path === "/config") {
      if (!authed(req)) return err(res, 401, "UNAUTHORIZED", "Valid agent-core bearer token required");
      if (req.method === "GET") return sendJson(res, 200, { success: true, config: publicConfig() });
      if (req.method === "POST") { applyConfig(await readJson(req)); return sendJson(res, 200, { success: true, config: publicConfig() }); }
    }

    if (!path.startsWith("/incidents")) return err(res, 404, "NOT_FOUND", "Route not found");
    if (!authed(req)) return err(res, 401, "UNAUTHORIZED", "Valid agent-core bearer token required");

    if (path === "/incidents" && req.method === "POST") {
      const body = await readJson(req);
      const problem = validateIncident(body);
      if (problem) return err(res, 400, "VALIDATION_ERROR", problem);
      // Monitoring switch (onboarding "Start monitoring"): when paused, record but don't investigate.
      if (!config.MONITORING_ACTIVE) {
        const record = store.create(body);
        record.status = "received";
        store.persist();
        return sendJson(res, 202, { success: true, incident: { id: record.incident.id, status: "received" }, monitoringActive: false });
      }
      const { record, completion } = investigator.startInvestigation(body);
      if (url.searchParams.get("wait") === "true") return sendJson(res, 200, { success: true, incident: await completion });
      completion.catch(() => {});
      return sendJson(res, 202, { success: true, incident: { id: record.incident.id, status: record.status }, statusUrl: `/incidents/${record.incident.id}` });
    }

    if (path === "/incidents" && req.method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit")) || 50, config.MAX_CONTEXT_INCIDENTS);
      return sendJson(res, 200, { success: true, incidents: store.list(limit), context: store.contextSummary() });
    }

    if (path === "/incidents/context" && req.method === "GET") return sendJson(res, 200, { success: true, context: store.contextSummary() });

    const m = path.match(/^\/incidents\/([^/]+)(\/feedback)?$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const isFeedback = Boolean(m[2]);

      if (!isFeedback && req.method === "GET") {
        const record = store.get(id);
        return record ? sendJson(res, 200, { success: true, incident: record }) : err(res, 404, "NOT_FOUND", "Incident not found");
      }

      if (isFeedback && req.method === "POST") {
        const body = await readJson(req);
        if (!["resolved", "unresolved"].includes(body.status)) return err(res, 400, "VALIDATION_ERROR", "status must be resolved or unresolved");
        const existing = store.get(id);
        if (!existing) return err(res, 404, "NOT_FOUND", "Incident not found");
        const record = store.setFeedback(id, body.status, body.note);
        if (body.status === "unresolved" && record.analysis) {
          const notification = await notifyEngineer(record.incident, record.analysis, `engineer marked unresolved${body.note ? `: ${body.note}` : ""}`);
          store.setNotification(id, notification);
          log("warn", "incident_escalated_by_feedback", { incidentId: id });
        }
        return sendJson(res, 200, { success: true, incident: store.get(id) });
      }
    }

    return err(res, 404, "NOT_FOUND", "Route not found");
  } catch (e) {
    return err(res, 400, "BAD_REQUEST", e.message);
  }
});

server.listen(config.PORT, () => log("info", "agent_core_listening", { port: config.PORT, mode: config.AGENT_MODE, connector: config.CONNECTOR_URL, codebase: config.CODEBASE_PATH || "(none)", llm: config.AGENT_MODE === "live" && config.GROQ_API_KEY ? config.GROQ_MODEL : "heuristic" }));

function shutdown(signal) {
  log("info", "agent_core_shutdown", { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
