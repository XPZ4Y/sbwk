// End-to-end SBWK demo — no Docker, no API keys required.
//
// Starts the Agent Connector (mock), Agent Core (heuristic), Middleware and a
// demo target Server, then drives real client requests through the middleware
// to show: detection -> dispatch -> investigation -> diagnosis -> escalation.
//
//   node demo/run-demo.mjs
//
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, "..");
const logDir = path.join(__dirname, "logs");
fs.mkdirSync(logDir, { recursive: true });

const CONNECTOR_TOKEN = "development-only-change-this-token-123456";
const AGENT_TOKEN = "development-only-change-this-agent-token-123456";
const ADMIN_TOKEN = "development-only-change-this-admin-token-123456";

const CONNECTOR = "http://localhost:4100";
const CORE = "http://localhost:4200";
const MIDDLEWARE = "http://localhost:8080";
const TARGET = "http://localhost:8000";

const children = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function start(name, cmd, args, cwd, env) {
  const fd = fs.openSync(path.join(logDir, `${name}.log`), "a");
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", fd, fd] });
  child._name = name;
  children.push(child);
  return child;
}

async function waitHealthy(url, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function setConnectorScenario(scenario) {
  await fetch(`${CONNECTOR}/connector/demo/scenario`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CONNECTOR_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ scenario })
  });
}

async function setTargetMode(mode) {
  await fetch(`${TARGET}/_control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode })
  });
}

async function waitForIncident(reqPath, sinceISO, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await fetch(`${CORE}/incidents?limit=50`, { headers: { Authorization: `Bearer ${AGENT_TOKEN}` } });
    const data = await r.json();
    const rec = (data.incidents || []).find(
      x => x.incident.path === reqPath && x.status === "analyzed" && x.createdAt >= sinceISO
    );
    if (rec) return rec;
    await sleep(300);
  }
  throw new Error(`No analyzed incident appeared for ${reqPath}`);
}

function printAnalysis(title, clientStatus, rec) {
  const a = rec.analysis;
  console.log(`\n=== ${title} ===`);
  console.log(`Client received: HTTP ${clientStatus}  (incident ${rec.incident.id.slice(0, 8)})`);
  console.log(`Diagnosis [${a.mode}] severity=${a.severity} confidence=${(a.confidence * 100).toFixed(0)}%`);
  console.log(`Root cause: ${a.rootCause.summary}`);
  const deps = a.dependencyFindings.map(d => `${d.service}:${d.status}`).join(", ") || "none";
  console.log(`Dependencies: ${deps}`);
  console.log(`Code findings: ${a.codeFindings.length}${a.codeFindings[0] ? ` (top: ${a.codeFindings[0].file}:${a.codeFindings[0].line})` : ""}`);
  console.log(`Suggested fixes:`);
  for (const f of a.suggestedFixes) console.log(`  - [${f.kind}] ${f.title}`);
  console.log(`Escalate to engineer: ${a.escalate}${a.escalationReason ? ` (${a.escalationReason})` : ""}`);
  if (rec.notification) console.log(`Notification: ${rec.notification.channel} — ${rec.notification.reason}`);
}

let target;

async function run() {
  console.log("Starting SBWK stack (connector, agent-core, middleware, target)...");

  start("connector", process.execPath, [path.join(repo, "services/agent-connector/server.mjs")], path.join(repo, "services/agent-connector"), {
    NODE_ENV: "development", PORT: "4100", CONNECTOR_MODE: "mock", CONNECTOR_API_TOKEN: CONNECTOR_TOKEN
  });
  start("agent-core", process.execPath, [path.join(repo, "services/agent-core/server.mjs")], path.join(repo, "services/agent-core"), {
    NODE_ENV: "development", PORT: "4200", AGENT_MODE: "mock",
    AGENT_CORE_TOKEN: AGENT_TOKEN, CONNECTOR_URL: CONNECTOR, CONNECTOR_API_TOKEN: CONNECTOR_TOKEN,
    CODEBASE_PATH: path.join(repo, "demo/target-app"), ESCALATION_CONFIDENCE_THRESHOLD: "0.5"
  });
  start("middleware", process.execPath, [path.join(repo, "services/middleware/server.mjs")], path.join(repo, "services/middleware"), {
    NODE_ENV: "development", PORT: "8080", TARGET_SERVER_URL: TARGET, AGENT_CORE_URL: CORE,
    AGENT_CORE_TOKEN: AGENT_TOKEN, MIDDLEWARE_ADMIN_TOKEN: ADMIN_TOKEN,
    DETECT_STATUS_MIN: "400", DISPATCH_COOLDOWN_MS: "0"
  });
  target = start("target", process.execPath, [path.join(repo, "demo/target-app/server.mjs")], repo, { PORT: "8000" });

  await waitHealthy(`${CONNECTOR}/health`);
  await waitHealthy(`${CORE}/health`);
  await waitHealthy(`${MIDDLEWARE}/health`);
  await waitHealthy(`${TARGET}/health`);
  console.log("All services healthy.\n");

  // Scenario 1: database failure -> 500
  await setConnectorScenario("database_failure");
  await setTargetMode("database");
  let since = new Date().toISOString();
  let res = await fetch(`${MIDDLEWARE}/users`);
  let rec = await waitForIncident("/users", since);
  printAnalysis("Scenario 1: database failure", res.status, rec);

  // Scenario 2: third-party API outage -> 503
  await setConnectorScenario("external_api_failure");
  await setTargetMode("external");
  since = new Date().toISOString();
  res = await fetch(`${MIDDLEWARE}/external`);
  rec = await waitForIncident("/external", since);
  printAnalysis("Scenario 2: third-party API outage", res.status, rec);

  // Scenario 3: missing route -> 404 (detected because DETECT_STATUS_MIN=400)
  await setConnectorScenario("normal");
  await setTargetMode("normal");
  since = new Date().toISOString();
  res = await fetch(`${MIDDLEWARE}/missing`);
  rec = await waitForIncident("/missing", since);
  printAnalysis("Scenario 3: missing route (404)", res.status, rec);

  // Scenario 4: the Server itself goes down -> 502, escalate
  await setConnectorScenario("normal");
  target.kill("SIGTERM");
  await sleep(500);
  since = new Date().toISOString();
  res = await fetch(`${MIDDLEWARE}/users`);
  rec = await waitForIncident("/users", since);
  printAnalysis("Scenario 4: application server down", res.status, rec);

  // Context retention + middleware observability
  const ctx = await (await fetch(`${CORE}/incidents/context`, { headers: { Authorization: `Bearer ${AGENT_TOKEN}` } })).json();
  console.log("\n=== Retained context ===");
  console.log(JSON.stringify(ctx.context, null, 2));

  const mw = await (await fetch(`${MIDDLEWARE}/_sbwk/status`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } })).json();
  console.log("\n=== Middleware incident counters ===");
  console.log(JSON.stringify(mw.incidents, null, 2));

  console.log(`\nFull service logs are in demo/logs/. Demo complete.`);
}

function shutdown() {
  for (const child of children) {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  }
}

run()
  .then(() => { shutdown(); setTimeout(() => process.exit(0), 500); })
  .catch(err => {
    console.error("\nDEMO FAILED:", err.message);
    console.error(`Check demo/logs/ for details.`);
    shutdown();
    setTimeout(() => process.exit(1), 500);
  });
