// Onboarding state persistence. Secrets are stored server-side and NEVER returned
// by the API (see redacted()).
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";

const initial = () => ({
  gateway: { targetUrl: config.DEFAULT_TARGET_URL, port: 8080, lastCheck: null },
  external: { authEndpoint: "", databaseEndpoint: "", apiKey: "", lastTest: null },
  codebase: { repoUrl: "", fullName: "", token: "", commits: [], connectedAt: null },
  safety: { dryRun: true, autoRollback: true, escalationThreshold: 0.8 },
  monitoring: { active: true, startedAt: null }
});

let state = initial();

function file() { return config.DATA_DIR ? path.join(config.DATA_DIR, "onboarding.json") : undefined; }

export function load() {
  const f = file();
  if (!f) return;
  try { state = { ...initial(), ...JSON.parse(fs.readFileSync(f, "utf8")) }; } catch { /* fresh */ }
}

export function persist() {
  const f = file();
  if (!f) return;
  try { fs.mkdirSync(config.DATA_DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(state, null, 2)); } catch { /* best-effort */ }
}

export function get() { return state; }
export function update(patch) { state = { ...state, ...patch }; persist(); return state; }
export function patch(section, value) { state[section] = { ...state[section], ...value }; persist(); return state[section]; }

// Strip secrets before sending state to the browser.
export function redacted() {
  return {
    gateway: state.gateway,
    external: { authEndpoint: state.external.authEndpoint, databaseEndpoint: state.external.databaseEndpoint, hasApiKey: Boolean(state.external.apiKey), lastTest: state.external.lastTest },
    codebase: { repoUrl: state.codebase.repoUrl, fullName: state.codebase.fullName, hasToken: Boolean(state.codebase.token), commits: state.codebase.commits, connectedAt: state.codebase.connectedAt },
    safety: state.safety,
    monitoring: state.monitoring
  };
}
