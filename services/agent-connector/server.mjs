// Zero-dependency Agent Connector — built-in node:http only.
import http from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { config } from "./config.mjs";
import { toolDefinitions, toFunctionTools, inspectService, investigateServices } from "./adapters.mjs";
import { getMockScenario, setMockScenario, mockScenarios } from "./mock.mjs";

const log = (level, event, fields = {}) =>
  console.log(JSON.stringify({ level, event, service: "agent-connector", timestamp: new Date().toISOString(), ...fields }));

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readJson(req, limit = 32768) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { reject(new Error("invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function authed(req) {
  if (config.NODE_ENV === "test") return true;
  const h = req.headers["authorization"] || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const expected = config.CONNECTOR_API_TOKEN;
  if (token.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

const err = (res, status, code, message) => sendJson(res, status, { success: false, error: { code, message } });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  const incoming = req.headers["x-request-id"];
  const requestId = incoming && /^[a-zA-Z0-9._:-]{1,100}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader("X-Request-Id", requestId);
  const start = process.hrtime.bigint();
  res.on("finish", () => log(res.statusCode >= 500 ? "error" : "info", "http_request_completed", {
    requestId, method: req.method, path, statusCode: res.statusCode,
    durationMs: Math.round(Number(process.hrtime.bigint() - start) / 1e6 * 100) / 100
  }));

  try {
    if (path === "/health" && req.method === "GET") return sendJson(res, 200, { success: true, service: "agent-connector", status: "healthy" });
    if (!path.startsWith("/connector/")) return err(res, 404, "NOT_FOUND", "Route not found");
    if (!authed(req)) return err(res, 401, "UNAUTHORIZED", "Valid connector bearer token required");

    if (path === "/connector/tools" && req.method === "GET") {
      const format = url.searchParams.get("format");
      if (format && format !== "native" && format !== "openai") return err(res, 400, "INVALID_FORMAT", "format must be native or openai");
      if (format === "openai") return sendJson(res, 200, { success: true, providerFormat: "openai-function-tools", readOnly: true, tools: toFunctionTools() });
      return sendJson(res, 200, { success: true, name: "sleepy-bot-agent-connector", version: "2.0.0", readOnly: true, invocation: { method: "POST", path: "/connector/execute" }, tools: toolDefinitions });
    }

    if (path === "/connector/execute" && req.method === "POST") {
      const body = await readJson(req);
      const def = toolDefinitions.find(t => t.name === body.tool);
      if (!def) return err(res, 400, "UNKNOWN_TOOL", "Tool is not registered");
      if (body.arguments && Object.keys(body.arguments).length) return err(res, 400, "INVALID_ARGUMENTS", "This diagnostic tool accepts no arguments");
      const check = def.name.replace(`inspect_${def.service}_`, "");
      return sendJson(res, 200, { success: true, result: await inspectService(def.service, check) });
    }

    if (path === "/connector/investigate" && req.method === "POST") {
      const body = await readJson(req);
      const services = Array.isArray(body.services) ? body.services.filter(s => ["database", "auth", "external_api"].includes(s)) : [];
      if (!services.length || services.length > 6) return err(res, 400, "VALIDATION_ERROR", "services must be 1-6 of database|auth|external_api");
      return sendJson(res, 200, { success: true, ...(await investigateServices(services)) });
    }

    if (path === "/connector/status" && req.method === "GET") {
      return sendJson(res, 200, { success: true, connector: "sleepy-bot-agent-connector", mode: config.CONNECTOR_MODE, readOnly: true, availableServices: ["database", "auth", "external_api"] });
    }

    if (path === "/connector/demo/scenario") {
      if (config.CONNECTOR_MODE !== "mock") return err(res, 404, "NOT_FOUND", "Demo controls are disabled in live mode");
      if (req.method === "GET") return sendJson(res, 200, { success: true, scenario: getMockScenario(), availableScenarios: mockScenarios });
      if (req.method === "POST") {
        const body = await readJson(req);
        if (!mockScenarios.includes(body.scenario)) return err(res, 400, "VALIDATION_ERROR", "Unknown demo scenario");
        return sendJson(res, 200, { success: true, scenario: setMockScenario(body.scenario) });
      }
    }

    // Runtime configuration from the control plane (onboarding Step 02).
    if (path === "/connector/config" && req.method === "POST") {
      const body = await readJson(req);
      if (body.mode === "mock" || body.mode === "live") config.CONNECTOR_MODE = body.mode;
      if (body.services && typeof body.services === "object") {
        for (const svc of ["database", "auth", "external_api"]) {
          const s = body.services[svc];
          if (!s || typeof s !== "object") continue;
          if (typeof s.baseUrl === "string") config.services[svc].baseUrl = s.baseUrl || undefined;
          if (typeof s.token === "string") config.services[svc].token = s.token || undefined;
          if (s.paths && typeof s.paths === "object") Object.assign(config.services[svc].paths, s.paths);
        }
      }
      log("info", "connector_config_updated", { mode: config.CONNECTOR_MODE });
      return sendJson(res, 200, {
        success: true, mode: config.CONNECTOR_MODE,
        services: Object.fromEntries(Object.entries(config.services).map(([k, v]) => [k, { configured: Boolean(v.baseUrl), paths: v.paths }]))
      });
    }

    return err(res, 404, "NOT_FOUND", "Route not found");
  } catch (e) {
    return err(res, 400, "BAD_REQUEST", e.message);
  }
});

server.listen(config.PORT, () => log("info", "connector_listening", { port: config.PORT, mode: config.CONNECTOR_MODE }));

function shutdown(signal) {
  log("info", "connector_shutdown", { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
