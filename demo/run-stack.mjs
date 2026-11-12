// Run the full SBWK stack persistently (dummy backend + connector + agent-core +
// middleware + control-plane). Zero dependencies. Open the control-plane UI to
// walk through the real onboarding.
//
//   node demo/run-stack.mjs
//
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, "..");

const CONNECTOR_TOKEN = "development-only-change-this-token-123456";
const AGENT_TOKEN = "development-only-change-this-agent-token-123456";
const ADMIN_TOKEN = "development-only-change-this-admin-token-123456";

const children = [];
function start(name, service, env) {
  const cwd = path.join(repo, "services", service);
  const child = spawn(process.execPath, ["server.mjs"], { cwd, env: { ...process.env, ...env }, stdio: "inherit" });
  child._name = name;
  children.push(child);
  child.on("exit", code => console.log(`[stack] ${name} exited (${code})`));
  return child;
}

console.log("[stack] starting SBWK…");
start("dummy-server", "dummy-server", { NODE_ENV: "development", PORT: "8000" });
start("connector", "agent-connector", { NODE_ENV: "development", PORT: "4100", CONNECTOR_MODE: "mock", CONNECTOR_API_TOKEN: CONNECTOR_TOKEN });
start("agent-core", "agent-core", {
  NODE_ENV: "development", PORT: "4200", AGENT_MODE: "mock",
  AGENT_CORE_TOKEN: AGENT_TOKEN, CONNECTOR_URL: "http://localhost:4100", CONNECTOR_API_TOKEN: CONNECTOR_TOKEN,
  CODEBASE_PATH: path.join(repo, "services/dummy-server"), ESCALATION_CONFIDENCE_THRESHOLD: "0.8", MONITORING_ACTIVE: "true"
});
start("middleware", "middleware", {
  NODE_ENV: "development", PORT: "8080", TARGET_SERVER_URL: "http://localhost:8000", AGENT_CORE_URL: "http://localhost:4200",
  AGENT_CORE_TOKEN: AGENT_TOKEN, MIDDLEWARE_ADMIN_TOKEN: ADMIN_TOKEN, DETECT_STATUS_MIN: "400", DETECT_SLOW_MS: "2000", DISPATCH_COOLDOWN_MS: "0"
});
start("control-plane", "control-plane", {
  NODE_ENV: "development", PORT: "4300",
  MIDDLEWARE_URL: "http://localhost:8080", MIDDLEWARE_ADMIN_TOKEN: ADMIN_TOKEN,
  CONNECTOR_URL: "http://localhost:4100", CONNECTOR_API_TOKEN: CONNECTOR_TOKEN,
  AGENT_CORE_URL: "http://localhost:4200", AGENT_CORE_TOKEN: AGENT_TOKEN,
  DEFAULT_TARGET_URL: "http://localhost:8000"
});

console.log("[stack] services: dummy=:8000  connector=:4100  agent-core=:4200  middleware=:8080  control-plane=:4300");
console.log("[stack] onboarding UI -> http://localhost:4300");

// Keep the parent alive and log a heartbeat.
setInterval(() => {}, 1 << 30);

function shutdown() {
  console.log("[stack] shutting down…");
  for (const c of children) { try { c.kill("SIGTERM"); } catch { /* ignore */ } }
  setTimeout(() => process.exit(0), 1000);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
