// End-to-end verification of the lazy two-stage gate against REAL services.
//
// Boots the middleware + agent-core (mock reasoner) + a dummy upstream + a fake
// Liquid d1 endpoint, then proves four things:
//
//   1. immediate mode (the default) still dispatches per request, byte-for-byte
//      like today — the batch path is never touched;
//   2. batch mode below BATCH_MIN_BAD sends NOTHING to agent-core;
//   3. batch mode at the threshold sends ONE batch, Liquid says "normal", and the
//      incidents land as `skipped` with no Groq call and no notification;
//   4. batch mode with Liquid down still reaches a real agent
//      (LIQUID_BATCH_FALLBACK=investigate).
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
// `mode` decides the noul probability it reports: "anomalous" | "normal" | "down".
let liquidMode = "normal";
let liquidCalls = 0;
let lastLiquidBody = null;

const liquid = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => { body += c; });
  req.on("end", () => {
    liquidCalls += 1;
    lastLiquidBody = body ? JSON.parse(body) : null;
    if (liquidMode === "down") { res.writeHead(500); return res.end('{"error":"liquid is down"}'); }
    const p = liquidMode === "anomalous" ? 0.97 : 0.04;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: "d1", answers: { looks_anomalous: { type: "noul", noul: p } }, usage: { input_tokens: 40 } }));
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

async function main() {
  await new Promise(r => liquid.listen(LIQUID_PORT, r));
  await new Promise(r => upstream.listen(8000, r));

  const coreEnv = {
    NODE_ENV: "development", PORT: "4200", AGENT_MODE: "mock",
    AGENT_CORE_TOKEN: AGENT_TOKEN, CONNECTOR_URL: "http://localhost:4998",
    CONNECTOR_API_TOKEN: "development-only-change-this-token-123456",
    ESCALATION_CONFIDENCE_THRESHOLD: "0.5",
    LIQUID_API_KEY: "liquid_test_key_123456", LIQUID_BASE_URL: `http://localhost:${LIQUID_PORT}`,
    LIQUID_TIMEOUT_MS: "2000", LIQUID_BATCH_ANOMALY_THRESHOLD: "0.6",
    AI_DEBUG: "false", DATA_DIR: ""
  };
  start("agent-core", "agent-core", coreEnv);
  const middlewareEnv = {
    NODE_ENV: "development", PORT: "8080", TARGET_SERVER_URL: "http://localhost:8000",
    AGENT_CORE_URL: CORE, AGENT_CORE_TOKEN: AGENT_TOKEN, MIDDLEWARE_ADMIN_TOKEN: ADMIN_TOKEN,
    DETECT_STATUS_MIN: "400", DISPATCH_COOLDOWN_MS: "0"
  };

  // ── 1. immediate mode: today's behaviour ────────────────────────────────
  start("middleware-immediate", "middleware", middlewareEnv);
  await waitHealthy(`${CORE}/health`);
  await waitHealthy(`${MIDDLEWARE}/health`);
  console.log("\n[1] immediate mode (DETECT_MODE unset) = today's behaviour");
  const beforeImmediate = (await core("/incidents?limit=100")).incidents.length;
  for (let i = 0; i < 3; i++) await hit();
  await sleep(700);
  const afterImmediate = (await core("/incidents?limit=100")).incidents;
  check("each bad request dispatched individually", afterImmediate.length - beforeImmediate === 3, `${afterImmediate.length - beforeImmediate} incidents`);
  const mwImmediate = await admin("/_sbwk/status");
  check("status reports mode=immediate", mwImmediate.mode === "immediate");
  check("batch buffer untouched", mwImmediate.batch.buffered === 0 && mwImmediate.batch.flushes === 0);
  children.pop().kill("SIGTERM");
  await sleep(400);

  // ── 2. batch mode below the threshold: nothing happens ──────────────────
  console.log("\n[2] batch mode, 2 bad requests, BATCH_MIN_BAD=3");
  start("middleware-batch", "middleware", {
    ...middlewareEnv, DETECT_MODE: "batch", BATCH_MIN_BAD: "3", BATCH_WINDOW_MS: "60000",
    BATCH_MAX_SIZE: "50", LIQUID_BATCH_FALLBACK: "investigate"
  });
  await waitHealthy(`${MIDDLEWARE}/health`);
  const beforeBatch = (await core("/incidents?limit=100")).incidents.length;
  await hit(); await hit();
  await sleep(800);
  const afterTwo = (await core("/incidents?limit=100")).incidents.length;
  check("no incident reaches agent-core yet", afterTwo === beforeBatch, `count still ${afterTwo}`);
  const status2 = await admin("/_sbwk/status");
  check("both bad requests are buffered", status2.batch.buffered === 2, `buffered=${status2.batch.buffered}`);
  check("no flush happened", status2.batch.flushes === 0);

  // ── 3. crossing the threshold with Liquid saying "normal" ───────────────
  console.log("\n[3] third bad request crosses BATCH_MIN_BAD; Liquid says normal");
  liquidMode = "normal";
  liquidCalls = 0;
  await hit();
  await sleep(1200);
  const afterThree = (await core("/incidents?limit=100")).incidents;
  const batched = afterThree.filter(r => r.batchId);
  check("one batch arrived, carrying 3 incidents", batched.length === 3, `${batched.length} batched records`);
  check("all three are stored as skipped", batched.every(r => r.status === "skipped"));
  check("no per-incident investigation ran", batched.every(r => r.analysis?.mode === "skipped"));
  check("Liquid was called exactly once for the whole batch", liquidCalls === 1, `${liquidCalls} call(s)`);
  check("the batch used the BATCH_QUESTIONS noul question", Boolean(lastLiquidBody?.questions?.looks_anomalous) && lastLiquidBody.questions.looks_anomalous.type === "noul");
  check("the batch state is a digest, not a raw incident", /BATCH OF BAD REQUESTS/.test(lastLiquidBody?.state || ""));
  check("DEFAULT_QUESTIONS questions were NOT sent", lastLiquidBody?.questions?.department === undefined);
  const status3 = await admin("/_sbwk/status");
  check("middleware recorded exactly one flush", status3.batch.flushes === 1, `flushes=${status3.batch.flushes}`);
  check("middleware recorded the gate action", status3.batch.last?.action === "skip", `action=${status3.batch.last?.action}`);

  // ── 4. Liquid down → the real agent path still runs ─────────────────────
  console.log("\n[4] Liquid down + LIQUID_BATCH_FALLBACK=investigate");
  liquidMode = "down";
  liquidCalls = 0;
  const before4 = (await core("/incidents?limit=100")).incidents.length;
  await hit(); await hit(); await hit();
  await sleep(2500);
  const after4 = (await core("/incidents?limit=100")).incidents;
  const new4 = after4.slice(0, after4.length - before4);
  check("a batch still arrived despite Liquid being down", new4.length === 3, `${new4.length} records`);
  check("the fallback gate ran a real investigation", new4.every(r => r.status === "analyzed" && r.analysis?.mode === "mock"));
  const status4 = await admin("/_sbwk/status");
  check("middleware mirrors the gate decision", status4.batch.last?.action === "investigate" && status4.batch.last?.liquidFallback === true, `last=${JSON.stringify(status4.batch.last)}`);
  check("the batch gate cost 1 Liquid attempt, then each incident's existing triage ran (1 + 3)", liquidCalls === 4, `${liquidCalls} calls`);

  // ── 5. agent-core totally unreachable → middleware replays per-incident ─
  console.log("\n[5] agent-core unreachable + LIQUID_BATCH_FALLBACK=investigate");
  const coreProc = children.find(c => c._name === "agent-core");
  coreProc.kill("SIGTERM");
  await sleep(600);
  await hit(); await hit(); await hit();
  await sleep(1500);
  const status5 = await admin("/_sbwk/status");
  check("middleware saw the batch fail", status5.batch.last?.ok === false);
  check("middleware attempted the real agent path for every incident", status5.batch.last?.fallbackAttempted === 3, `attempted=${status5.batch.last?.fallbackAttempted}`);
  check("nothing was silently dropped (0 dispatched only because agent-core is down)", status5.batch.last?.fallbackDispatched === 0, `dispatched=${status5.batch.last?.fallbackDispatched}`);

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
