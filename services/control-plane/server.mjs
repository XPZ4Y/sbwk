// Zero-dependency onboarding control plane. Serves the UI and makes every
// onboarding step real: gateway healthcheck, external connection tests, GitHub
// repo + last-5-commits link, safety limits, and the monitoring switch.
import http from "node:http";
import fs from "node:fs";
import { config } from "./config.mjs";
import * as store from "./store.mjs";
import { checkReachability, fetchGitHubRepo } from "./checks.mjs";
import { applyGateway, applyExternal, applyCodebase, applySafety, applyMonitoring, serviceHealth } from "./apply.mjs";

store.load();

const log = (level, event, fields = {}) => console.log(JSON.stringify({ level, event, service: "control-plane", timestamp: new Date().toISOString(), ...fields }));
function sendJson(res, status, obj) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }
const ok = (res, obj) => sendJson(res, 200, { success: true, ...obj });
const fail = (res, status, message) => sendJson(res, status, { success: false, error: message });

function readJson(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new Error("invalid JSON")); } });
    req.on("error", reject);
  });
}

const indexHtml = fs.readFileSync(new URL("./public/index.html", import.meta.url), "utf8");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  try {
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(indexHtml);
    }

    if (p === "/api/state" && req.method === "GET") {
      return ok(res, { state: store.redacted(), services: await serviceHealth() });
    }

    // STEP 01 — Gateway
    if (p === "/api/gateway" && req.method === "POST") {
      const body = await readJson(req);
      if (!body.targetUrl) return fail(res, 400, "targetUrl is required");
      try { new URL(body.targetUrl); } catch { return fail(res, 400, "targetUrl must be a valid URL"); }
      store.patch("gateway", { targetUrl: body.targetUrl, port: Number(body.port) || 8080 });
      const apply = await applyGateway(store.get());
      log("info", "gateway_configured", { targetUrl: body.targetUrl, apply });
      return ok(res, { gateway: store.get().gateway, apply });
    }
    if (p === "/api/gateway/check" && req.method === "POST") {
      const target = store.get().gateway.targetUrl;
      const check = await checkReachability(target);
      store.patch("gateway", { lastCheck: { ...check, at: new Date().toISOString() } });
      return ok(res, { check });
    }

    // STEP 02 — External access
    if (p === "/api/external" && req.method === "POST") {
      const body = await readJson(req);
      store.patch("external", { authEndpoint: body.authEndpoint || "", databaseEndpoint: body.databaseEndpoint || "", ...(typeof body.apiKey === "string" && body.apiKey ? { apiKey: body.apiKey } : {}) });
      return ok(res, { external: store.redacted().external });
    }
    if (p === "/api/external/test" && req.method === "POST") {
      const ext = store.get().external;
      const [auth, database] = await Promise.all([
        ext.authEndpoint ? checkReachability(ext.authEndpoint, { token: ext.apiKey }) : { ok: false, error: "not configured" },
        ext.databaseEndpoint ? checkReachability(ext.databaseEndpoint) : { ok: false, error: "not configured" }
      ]);
      const reachable = [auth, database].filter(r => r.reachable).length;
      store.patch("external", { lastTest: { auth, database, reachable, at: new Date().toISOString() } });
      const apply = await applyExternal(store.get());
      return ok(res, { auth, database, reachable, total: 2, apply });
    }

    // STEP 03 — Codebase link (real GitHub API)
    if (p === "/api/codebase" && req.method === "POST") {
      const body = await readJson(req);
      if (!body.repoUrl) return fail(res, 400, "repoUrl is required");
      let repo;
      try { repo = await fetchGitHubRepo(body.repoUrl, body.token); }
      catch (e) { return fail(res, 400, e.message); }
      store.patch("codebase", { repoUrl: repo.repoUrl, fullName: repo.fullName, commits: repo.commits, connectedAt: new Date().toISOString(), ...(body.token ? { token: body.token } : {}) });
      const apply = await applyCodebase(store.get());
      log("info", "codebase_linked", { fullName: repo.fullName, commits: repo.commits.length, apply });
      return ok(res, { codebase: { fullName: repo.fullName, repoUrl: repo.repoUrl, defaultBranch: repo.defaultBranch, commits: repo.commits }, apply });
    }

    // STEP 04 — Safety limits
    if (p === "/api/safety" && req.method === "POST") {
      const body = await readJson(req);
      const patch = {};
      if (typeof body.dryRun === "boolean") patch.dryRun = body.dryRun;
      if (typeof body.autoRollback === "boolean") patch.autoRollback = body.autoRollback;
      if (typeof body.escalationThreshold === "number" && body.escalationThreshold >= 0 && body.escalationThreshold <= 1) patch.escalationThreshold = body.escalationThreshold;
      store.patch("safety", patch);
      const apply = await applySafety(store.get());
      return ok(res, { safety: store.get().safety, apply });
    }

    // Monitoring switch
    if (p === "/api/monitoring/start" && req.method === "POST") {
      store.patch("monitoring", { active: true, startedAt: new Date().toISOString() });
      const apply = await applyMonitoring(true);
      log("info", "monitoring_started", { apply });
      return ok(res, { monitoring: store.get().monitoring, apply });
    }
    if (p === "/api/monitoring/stop" && req.method === "POST") {
      store.patch("monitoring", { active: false });
      const apply = await applyMonitoring(false);
      return ok(res, { monitoring: store.get().monitoring, apply });
    }

    // Live incident feed (proxied from agent-core) for the monitoring view.
    if (p === "/api/incidents" && req.method === "GET") {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), config.REQUEST_TIMEOUT_MS);
      try {
        const r = await fetch(`${config.AGENT_CORE_URL}/incidents?limit=10`, { headers: { Authorization: `Bearer ${config.AGENT_CORE_TOKEN}` }, signal: controller.signal });
        const data = await r.json();
        return ok(res, { incidents: data.incidents || [], context: data.context || {} });
      } catch { return ok(res, { incidents: [], context: {} }); }
      finally { clearTimeout(t); }
    }

    return fail(res, 404, "Not found");
  } catch (e) {
    log("error", "request_failed", { path: p, error: e.message });
    return fail(res, 500, e.message);
  }
});

server.listen(config.PORT, () => log("info", "control_plane_listening", { port: config.PORT }));
function shutdown(signal) { log("info", "control_plane_shutdown", { signal }); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 5000).unref(); }
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
