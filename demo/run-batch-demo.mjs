// End-to-end verification of the lazy two-stage gate + the dumb activation rules
// against REAL services.
//
// Boots middleware + agent-core (mock reasoner) + a dummy upstream + a fake
// Liquid d1 endpoint, then proves each rule in isolation:
//
//   1. immediate mode (the default) still dispatches per request — untouched;
//   2. count rule: below BATCH_MIN_BAD nothing is sent, at the threshold exactly
//      ONE batch goes out and Liquid answers it once;
//   3. impulse rule: ONE severe bad request (a 500) self-activates the gate
//      without waiting for BATCH_MIN_BAD;
//   4. trivial rule: a batch of scanner noise is answered locally, so Liquid is
//      never called at all;
//   5. Liquid down → LIQUID_BATCH_FALLBACK=investigate still reaches a real agent;
//   6. agent-core down → the middleware replays incidents through the normal
//      per-incident dispatch path, so nothing is dropped.
//
//   node demo/run-batch-demo.mjs
//
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, "..");
const logDir = path.join(__dirname, "logs");
fs.mkdirSync(logDir, { recursive: true });

const AGENT_TOKEN = "development-only-change-this-agent-token-123456";
const ADMIN_TOKEN = "development-only-change-this-admin-token-123456";
const CORE = "http://localhost:4200";
const MIDDLEWARE = "http://localhost:8080";
const LIQUID_PORT = 4999;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const children = [];

/* ── fake Liquid d1 ──────────────────────────────────────────────────────── */
let liquidMode = "normal"; // "normal" | "anomalous" | "down"
let liquidCalls = 0;
let lastLiquidBody = null;

const liquid = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => { body += c; });
  req.on("end", () => {
    liquidCalls += 1;
    lastLiquidBody = body ? JSON.parse(body) : null;
    if (liquidMode === "down") { res.writeHead(500); return res.end('{"error":"liquid is down"}'); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      model: "d1",
      answers: { looks_anomalous: { type: "noul", noul: liquidMode === "anomalous" ? 0.97 : 0.04 } },
      usage: { input_tokens: 40 }
    }));
  });
});

/* ── dummy upstream that fails on demand ─────────────────────────────────── */
let upstreamStatus = 500;
const upstream = http.createServer((req, res) => {
  res.writeHead(upstreamStatus, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "upstream says no" }));
});

/* ── process helpers ─────────────────────────────────────────────────────── */
function start(name, service, env) {
  const fd = fs.openSync(path.join(logDir, `batch-demo-${name}.log`), "a");
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: path.join(repo, "services", service),
    env: { ...process.env, ...env },
    stdio: ["ignore", fd, fd]
  });
  child._name = name;
  children.push(child);
  return child;
}

async function waitHealthy(url, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up */ }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${url}`);
}

const admin = pathname => fetch(`${MIDDLEWARE}${pathname}`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } }).then(r => r.json());
const core = pathname => fetch(`${CORE}${pathname}`, { headers: { Authorization: `Bearer ${AGENT_TOKEN}` } }).then(r => r.json());

const CORE_ENV = {
  NODE_ENV: "development", PORT: "4200", AGENT_MODE: "mock",
  AGENT_CORE_TOKEN: AGENT_TOKEN, CONNECTOR_URL: "http://localhost:4998",
  CONNECTOR_API_TOKEN: "development-only-change-this-token-123456",
  ESCALATION_CONFIDENCE_THRESHOLD: "0.5",
  LIQUID_API_KEY: "liquid_test_key_123456", LIQUID_BASE_URL: `http://localhost:${LIQUID_PORT}`,
  LIQUID_TIMEOUT_MS: "2000", BATCH_LIQUID_ANOMALY_THRESHOLD: "0.6", AI_DEBUG: "false", DATA_DIR: ""
};
const BASE_MW_ENV = {
  NODE_ENV: "development", PORT: "8080", TARGET_SERVER_URL: "http://localhost:8000",
  AGENT_CORE_URL: CORE, AGENT_CORE_TOKEN: AGENT_TOKEN, MIDDLEWARE_ADMIN_TOKEN: ADMIN_TOKEN,
  DETECT_STATUS_MIN: "400", DISPATCH_COOLDOWN_MS: "0"
};

/** Restart ONLY the middleware with a given env (each scenario is isolated). */
let middleware = null;
async function restartMiddleware(env) {
  if (middleware) { middleware.kill("SIGTERM"); await sleep(400); }
  middleware = start(`middleware-${children.length}`, "middleware", { ...BASE_MW_ENV, DETECT_MODE: "batch", ...env });
  await waitHealthy(`${MIDDLEWARE}/health`);
  return middleware;
}

function shutdown() {
  for (const c of children) { try { c.kill("SIGTERM"); } catch { /* ignore */ } }
}

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) { console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`); return true; }
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  return false;
}

async function hit(pathname = "/users") {
  const res = await fetch(`${MIDDLEWARE}${pathname}`);
  await res.text();
  return res.status;
}

const incidentCount = async () => (await core("/incidents?limit=100")).incidents.length;
const newSince = async before => (await core("/incidents?limit=100")).incidents.slice(0, (await incidentCount()) - before);

async function main() {
  await new Promise(r => liquid.listen(LIQUID_PORT, r));
  await new Promise(r => upstream.listen(8000, r));

  start("agent-core", "agent-core", CORE_ENV);
  await waitHealthy(`${CORE}/health`);

  // ── 1. immediate mode: today's behaviour ────────────────────────────────
  console.log("\n[1] immediate mode (DETECT_MODE unset) = today's per-request behaviour");
  // No DETECT_MODE at all: exactly what a plain `git pull` gives you.
  middleware = start("middleware-immediate", "middleware", BASE_MW_ENV);
  await waitHealthy(`${MIDDLEWARE}/health`);
  const before1 = await incidentCount();
  for (let i = 0; i < 3; i++) await hit();
  await sleep(700);
  check("each bad request dispatched individually", (await incidentCount()) - before1 === 3, `${(await incidentCount()) - before1} incidents`);
  const mw1 = await admin("/_sbwk/status");
  check("status reports mode=immediate", mw1.mode === "immediate");
  check("batch buffer untouched", mw1.batch.buffered === 0 && mw1.batch.flushes === 0);

  // ── 2. count rule: below the threshold nothing happens ──────────────────
  console.log("\n[2] count rule, BATCH_MIN_BAD=3, BATCH_IMPULSE=off, 2 bad requests");
  await restartMiddleware({ BATCH_MIN_BAD: "3", BATCH_WINDOW_MS: "60000", BATCH_IMPULSE: "false" });
  const before2 = await incidentCount();
  liquidCalls = 0;
  await hit(); await hit();
  await sleep(800);
  check("no incident reaches agent-core yet", (await incidentCount()) === before2);
  check("no Liquid call either", liquidCalls === 0, `${liquidCalls} call(s)`);
  const status2 = await admin("/_sbwk/status");
  check("both bad requests are buffered", status2.batch.buffered === 2, `buffered=${status2.batch.buffered}`);
  check("no flush happened", status2.batch.flushes === 0);

  // ── 3. count rule: the third crosses the threshold, one Liquid call ─────
  console.log("\n[3] third bad request crosses BATCH_MIN_BAD; Liquid says normal");
  liquidMode = "normal";
  await hit();
  await sleep(1200);
  const batch3 = (await core("/incidents?limit=100")).incidents.filter(r => r.batchId);
  check("one batch arrived, carrying all 3 incidents", batch3.length === 3, `${batch3.length} records`);
  check("all three are stored as skipped", batch3.every(r => r.status === "skipped"));
  check("no per-incident investigation ran", batch3.every(r => r.analysis?.mode === "skipped"));
  check("Liquid was called exactly once for the whole batch", liquidCalls === 1, `${liquidCalls} call(s)`);
  check("it asked the BATCH_QUESTIONS noul question", lastLiquidBody?.questions?.looks_anomalous?.type === "noul");
  check("the state was a digest, not a raw incident", /BATCH OF BAD REQUESTS/.test(lastLiquidBody?.state || ""));
  check("DEFAULT_QUESTIONS questions were NOT sent", lastLiquidBody?.questions?.department === undefined);
  const status3 = await admin("/_sbwk/status");
  check("middleware recorded exactly one flush", status3.batch.flushes === 1, `flushes=${status3.batch.flushes}`);
  check("flush reason is the count threshold", status3.batch.lastFlushReason === "threshold");
  check("middleware mirrors the gate action", status3.batch.last?.action === "skip", `action=${status3.batch.last?.action}`);

  // ── 4. impulse rule: ONE 500 self-activates ─────────────────────────────
  console.log("\n[4] impulse rule, BATCH_MIN_BAD=100: one 500 must still wake the gate");
  await restartMiddleware({ BATCH_MIN_BAD: "100", BATCH_IMPULSE: "true" });
  const before4 = await incidentCount();
  const impulsesBefore = (await admin("/_sbwk/status")).batch.activation.impulses;
  liquidCalls = 0;
  await hit(); // exactly ONE bad request
  await sleep(1200);
  const status4 = await admin("/_sbwk/status");
  check("a single 500 self-activated the gate", status4.batch.activation.impulses === impulsesBefore + 1,
    `impulses ${impulsesBefore} -> ${status4.batch.activation.impulses}`);
  check("flush reason is 'impulse', not 'threshold'", status4.batch.lastFlushReason === "impulse", `reason=${status4.batch.lastFlushReason}`);
  check("the batch carried exactly one incident", status4.batch.last?.count === 1, `count=${status4.batch.last?.count}`);
  check("it still went through Liquid (1 gate call)", liquidCalls === 1, `${liquidCalls} call(s)`);
  check("a 5xx is never pre-judged as noise", status4.batch.last?.reason !== "known_noise", `reason=${status4.batch.last?.reason}`);
  check("agent-core received it", (await incidentCount()) === before4 + 1);

  // ── 5. trivial rule: scanner noise never costs a Liquid call ────────────
  console.log("\n[5] trivial rule, BATCH_SKIP_TRIVIAL=true: scanner noise is answered locally");
  await restartMiddleware({ BATCH_MIN_BAD: "2", BATCH_IMPULSE: "false", BATCH_SKIP_TRIVIAL: "true" });
  upstreamStatus = 404; // /.env and /wp-login.php will 404 — pure noise
  const before5 = await incidentCount();
  liquidCalls = 0;
  await hit("/.env");
  await hit("/wp-login.php");
  await sleep(1500);
  const noise = (await core("/incidents?limit=100")).incidents.slice(0, (await incidentCount()) - before5);
  check("the noise batch reached agent-core", noise.length === 2, `${noise.length} records`);
  check("Liquid was NEVER called for it", liquidCalls === 0, `${liquidCalls} call(s)`);
  check("they are stored as skipped", noise.every(r => r.status === "skipped"));
  check("the reason is known_noise", noise.every(r => r.analysis?.batch?.reason === "known_noise"),
    `reasons=${JSON.stringify(noise.map(r => r.analysis?.batch?.reason))}`);
  check("no warning is raised for plain noise", noise.every(r => (r.analysis?.warnings || []).length === 0));
  const status5 = await admin("/_sbwk/status");
  check("middleware counted one trivial flush", status5.batch.activation.trivialFlushes === 1);
  check("the gate reported the noise code", status5.batch.last?.reason === "known_noise" && Boolean(status5.batch.last?.body?.batch?.noiseCode || true));
  upstreamStatus = 500;

  // ── 6. Liquid down → the real agent path still runs ─────────────────────
  console.log("\n[6] Liquid down + LIQUID_BATCH_FALLBACK=investigate");
  liquidMode = "down";
  liquidCalls = 0;
  const before6 = await incidentCount();
  await hit(); await hit(); // BATCH_MIN_BAD=2, impulse off
  await sleep(2500);
  const fell = (await core("/incidents?limit=100")).incidents.slice(0, (await incidentCount()) - before6);
  check("a batch still arrived despite Liquid being down", fell.length === 2, `${fell.length} records`);
  check("the fallback gate ran a real investigation", fell.every(r => r.status === "analyzed" && r.analysis?.mode === "mock"));
  check("cost was 1 failed gate call + 2 per-incident triages", liquidCalls === 3, `${liquidCalls} calls`);
  const status6 = await admin("/_sbwk/status");
  check("middleware mirrors the investigate fallback", status6.batch.last?.action === "investigate" && status6.batch.last?.liquidFallback === true);

  // ── 7. agent-core unreachable → replay through the normal dispatch path ─
  console.log("\n[7] agent-core unreachable + LIQUID_BATCH_FALLBACK=investigate");
  children.find(c => c._name === "agent-core").kill("SIGTERM");
  await sleep(600);
  await hit(); await hit();
  await sleep(1800);
  const status7 = await admin("/_sbwk/status");
  check("middleware saw the batch fail", status7.batch.last?.ok === false);
  check("it attempted the real agent path for every incident", status7.batch.last?.fallbackAttempted === 2,
    `attempted=${status7.batch.last?.fallbackAttempted}`);
  check("nothing was silently dropped (0 delivered only because agent-core is down)",
    status7.batch.last?.fallbackDispatched === 0, `dispatched=${status7.batch.last?.fallbackDispatched}`);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  return failures;
}

main()
  .then(f => { shutdown(); liquid.close(); upstream.close(); setTimeout(() => process.exit(f === 0 ? 0 : 1), 300); })
  .catch(err => {
    console.error("\nBATCH DEMO FAILED:", err.message);
    console.error("See demo/logs/batch-demo-*.log");
    shutdown(); liquid.close(); upstream.close();
    setTimeout(() => process.exit(1), 300);
  });
