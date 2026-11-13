// Zero-dependency Agent Core HTTP API.
import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { config, investigateServices } from "./config.mjs";
import { IncidentStore } from "./store.mjs";
import { inspectCodebase } from "./codebase.mjs";
import { reason } from "./reason.mjs";
import { notifyEngineer } from "./notify.mjs";
import { createInvestigator, makeConnectorClient } from "./investigate.mjs";
import { liquidTriage, DEFAULT_QUESTIONS, DEFAULT_ROUTE_POLICY, BATCH_QUESTIONS } from "./liquid.mjs";
import { createBatchGate } from "./batch.mjs";
import { listProfiles, resolvePromptSettings, PROMPT_PROFILES } from "./prompts.mjs";

const log = (level, event, fields = {}) =>
  console.log(JSON.stringify({ level, event, service: "agent-core", timestamp: new Date().toISOString(), ...fields }));

const store = new IncidentStore(config.MAX_CONTEXT_INCIDENTS, config.DATA_DIR);
store.load();
const investigatorDeps = {
  store,
  investigateDependencies: makeConnectorClient(config),
  inspectCodebase,
  reason,
  notifyEngineer,
  triage: input => liquidTriage(input, config),
  config,
  services: investigateServices
};
const investigator = createInvestigator(investigatorDeps);

// Prompt-testing harness: runs the full pipeline (Liquid -> Groq) on a synthetic
// incident without persisting it and without firing any engineer notification.
// Nothing it does can pollute the retained context.
const testStore = new IncidentStore(5);
const testInvestigator = createInvestigator({
  ...investigatorDeps,
  store: testStore,
  notifyEngineer: async () => ({ channel: "test-run", sent: false, reason: "test run — notification suppressed" })
});

// Lazy two-stage gate (stage two). The middleware buffers bad requests and only
// calls us when a pattern forms; this gate asks Liquid d1 whether that pattern
// is worth a real LLM call at all. Uses the SAME investigator as `POST /incidents`
// once it decides to investigate, and the same Liquid client for the gate call.
const batchGate = createBatchGate({
  store,
  investigator,
  config,
  maxIncidents: config.BATCH_MAX_INCIDENTS,
  liquidGate: state => liquidTriage({}, config, { state, questions: BATCH_QUESTIONS })
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
  const prompt = resolvePromptSettings(config);
  return {
    mode: config.AGENT_MODE,
    monitoringActive: config.MONITORING_ACTIVE,
    dryRun: config.DRY_RUN,
    autoRollback: config.AUTO_ROLLBACK,
    escalationThreshold: config.ESCALATION_CONFIDENCE_THRESHOLD,
    connectorUrl: config.CONNECTOR_URL,
    codebasePath: config.CODEBASE_PATH || null,
    codebase: { repoUrl: config.codebase.repoUrl || null, fullName: config.codebase.fullName || null, commitCount: config.codebase.commits.length },
    // Liquid d1 triage router. The key itself is never returned.
    liquid: {
      configured: Boolean(config.LIQUID_API_KEY) && config.LIQUID_ENABLED !== false,
      hasKey: Boolean(config.LIQUID_API_KEY),
      enabled: config.LIQUID_ENABLED !== false,
      model: config.LIQUID_MODEL,
      baseUrl: config.LIQUID_BASE_URL,
      decisionsPath: config.LIQUID_DECISIONS_PATH,
      timeoutMs: config.LIQUID_TIMEOUT_MS,
      routePolicy: { ...DEFAULT_ROUTE_POLICY, ...(config.LIQUID_ROUTE_POLICY || {}) },
      questions: config.LIQUID_QUESTIONS || DEFAULT_QUESTIONS
    },
    // Groq prompt configuration (everything here is safe to show and edit).
    llm: {
      mode: config.AGENT_MODE,
      model: config.GROQ_MODEL,
      baseUrl: config.GROQ_BASE_URL,
      hasKey: Boolean(config.GROQ_API_KEY),
      profile: prompt.profile,
      isCustom: prompt.isCustom,
      temperature: prompt.temperature,
      maxTokens: prompt.maxTokens,
      systemPrompt: prompt.systemPrompt,
      userPromptTemplate: prompt.userPromptTemplate,
      profiles: listProfiles()
    },
    aiDebug: config.AI_DEBUG,
    // Lazy two-stage gate (middleware buffers; Liquid decides if it matters).
    batch: {
      threshold: config.BATCH_LIQUID_ANOMALY_THRESHOLD,
      fallback: config.LIQUID_BATCH_FALLBACK,
      maxIncidents: config.BATCH_MAX_INCIDENTS,
      questions: Object.keys(BATCH_QUESTIONS)
    }
  };
}

const RESET = null; // sentinel: clear an override back to the env/profile default

function applyLiquidConfig(liquid) {
  if (!liquid || typeof liquid !== "object") return;
  if (typeof liquid.apiKey === "string") config.LIQUID_API_KEY = liquid.apiKey.trim() || undefined;
  if (typeof liquid.model === "string" && liquid.model.trim()) config.LIQUID_MODEL = liquid.model.trim().slice(0, 128);
  if (typeof liquid.enabled === "boolean") config.LIQUID_ENABLED = liquid.enabled;
  if (typeof liquid.baseUrl === "string" && liquid.baseUrl.trim()) config.LIQUID_BASE_URL = liquid.baseUrl.trim();
  if (liquid.routePolicy && typeof liquid.routePolicy === "object") {
    config.LIQUID_ROUTE_POLICY = { ...DEFAULT_ROUTE_POLICY, ...(config.LIQUID_ROUTE_POLICY || {}), ...liquid.routePolicy };
  }
  if (liquid.questions && typeof liquid.questions === "object") config.LIQUID_QUESTIONS = liquid.questions;
}

/**
 * Prompt overrides for the Groq reasoner. Send `{ profile: "diff_first" }` to
 * switch strategy, explicit `systemPrompt`/`userPromptTemplate` to go fully
 * custom, or `{ reset: true }` to drop all overrides and return to the profile.
 */
function applyLlmConfig(llm) {
  if (!llm || typeof llm !== "object") return;
  if (llm.reset === true) { config.llm = {}; return; }
  const next = { ...(config.llm || {}) };
  if (typeof llm.profile === "string" && llm.profile.trim()) {
    const id = llm.profile.trim();
    if (!PROMPT_PROFILES[id]) { log("warn", "unknown_prompt_profile", { profile: id }); }
    else {
      next.profile = id;
      // Switching profile clears custom text so the profile actually takes effect.
      if (llm.systemPrompt === undefined) delete next.systemPrompt;
      if (llm.userPromptTemplate === undefined) delete next.userPromptTemplate;
    }
  }
  if (typeof llm.systemPrompt === "string") next.systemPrompt = llm.systemPrompt.trim() ? llm.systemPrompt : RESET;
  if (typeof llm.userPromptTemplate === "string") next.userPromptTemplate = llm.userPromptTemplate.trim() ? llm.userPromptTemplate : RESET;
  if (typeof llm.temperature === "number" && llm.temperature >= 0 && llm.temperature <= 2) next.temperature = llm.temperature;
  if (typeof llm.maxTokens === "number" && llm.maxTokens >= 256 && llm.maxTokens <= 16000) next.maxTokens = Math.round(llm.maxTokens);
  if (typeof llm.model === "string" && llm.model.trim()) config.GROQ_MODEL = llm.model.trim();
  for (const k of Object.keys(next)) if (next[k] === RESET) delete next[k];
  config.llm = next;
}

function applyConfig(body) {
  if (typeof body.escalationThreshold === "number" && body.escalationThreshold >= 0 && body.escalationThreshold <= 1) config.ESCALATION_CONFIDENCE_THRESHOLD = body.escalationThreshold;
  if (typeof body.aiDebug === "boolean") config.AI_DEBUG = body.aiDebug;
  applyLiquidConfig(body.liquid);
  applyLlmConfig(body.llm);
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

/** Synthetic incident used by the prompt-testing harness (POST /incidents?test=true). */
function syntheticIncident(body = {}) {
  const id = `test-${randomUUID()}`;
  const now = new Date().toISOString();
  return {
    id,
    requestId: id,
    source: "control-plane-test",
    method: typeof body.method === "string" && body.method ? body.method : "POST",
    path: typeof body.path === "string" && body.path ? body.path : "/checkout",
    statusCode: Number.isInteger(body.statusCode) ? body.statusCode : 500,
    durationMs: Number.isFinite(Number(body.durationMs)) ? Number(body.durationMs) : 1200,
    upstream: typeof body.upstream === "string" && body.upstream ? body.upstream : "http://server:8000",
    category: typeof body.category === "string" && body.category ? body.category : "server_error",
    reason: typeof body.reason === "string" && body.reason ? body.reason : "HTTP 500 (prompt test)",
    detectedAt: now,
    ...(typeof body.error === "string" && body.error ? { error: body.error } : {}),
    ...(typeof body.responseSample === "string" && body.responseSample ? { responseSample: body.responseSample } : {})
  };
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
      // Prompt-testing harness: run the pipeline on a synthetic incident and
      // return the full analysis (including aiDebug). Never stored, never notifies.
      if (url.searchParams.get("test") === "true") {
        const incident = syntheticIncident(body);
        const record = await testInvestigator.runInvestigation(incident);
        return sendJson(res, 200, { success: true, test: true, incident: record });
      }
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

    // ── lazy two-stage gate: one compact batch from the middleware ─────────
    // Body: { batchId, batch:{reason,minBad,windowMs}, digest:{...}, incidents:[...] }
    // Liquid d1 answers a single noul question about the digest:
    //   not anomalous → every incident stored `skipped` (no Groq, no notify)
    //   anomalous     → each incident runs through the existing investigator
    //   Liquid down   → LIQUID_BATCH_FALLBACK (investigate | skip)
    if (path === "/incidents/batch" && req.method === "POST") {
      const body = await readJson(req, 512 * 1024);
      const awaitIt = url.searchParams.get("wait") === "true";
      const result = await batchGate.process(body, { awaitInvestigations: awaitIt });
      return sendJson(res, awaitIt ? 200 : 202, { success: true, batch: result });
    }

    if (path === "/incidents/batch" && req.method === "GET") {
      return sendJson(res, 200, { success: true, settings: batchGate.settings(), recent: batchGate.recent() });
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

server.listen(config.PORT, () => log("info", "agent_core_listening", { port: config.PORT, mode: config.AGENT_MODE, connector: config.CONNECTOR_URL, codebase: config.CODEBASE_PATH || "(none)", llm: config.AGENT_MODE === "live" && config.GROQ_API_KEY ? config.GROQ_MODEL : "heuristic", liquid: config.LIQUID_API_KEY && config.LIQUID_ENABLED !== false ? `${config.LIQUID_MODEL} triage` : "not configured (Groq default)" }));

function shutdown(signal) {
  log("info", "agent_core_shutdown", { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
