// Onboarding state. Secrets (service tokens, GitHub token) are stored here and
// never returned by redacted(). Writes are atomic: temp file, then rename.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.mjs";
import { inferScheme } from "./external.mjs";

const defaults = () => ({
  gateway: { targetUrl: config.DEFAULT_TARGET_URL, port: 8080, lastCheck: null },
  external: { services: [] },
  codebase: { repoUrl: "", fullName: "", defaultBranch: null, token: "", commits: [], connectedAt: null },
  safety: { dryRun: true, autoRollback: true, escalationThreshold: 0.8 },
  monitoring: { active: false, startedAt: null }
});

// Accepts any persisted shape (current or legacy) and returns the current one.
export function migrate(parsed = {}) {
  const base = defaults();
  const out = {
    gateway: { ...base.gateway, ...(parsed.gateway || {}) },
    external: { services: [] },
    codebase: { ...base.codebase, ...(parsed.codebase || {}) },
    safety: { ...base.safety, ...(parsed.safety || {}) },
    monitoring: { ...base.monitoring, ...(parsed.monitoring || {}) }
  };
  if (Array.isArray(parsed.external?.services)) {
    out.external.services = parsed.external.services;
  } else if (parsed.external) {
    // Legacy shape: { authEndpoint, databaseEndpoint, apiKey }. The shared API key
    // belonged to the auth service in the old UI, so it goes there only.
    const legacy = parsed.external;
    if (legacy.authEndpoint) out.external.services.push({ id: "svc_auth", name: "auth", kind: "auth", endpoint: legacy.authEndpoint, token: legacy.apiKey || "", lastCheck: null });
    if (legacy.databaseEndpoint) out.external.services.push({ id: "svc_database", name: "database", kind: "database", endpoint: legacy.databaseEndpoint, token: "", lastCheck: null });
  }
  return out;
}

let state = defaults();
const file = () => (config.DATA_DIR ? path.join(config.DATA_DIR, "onboarding.json") : undefined);

export function load() {
  const f = file();
  if (!f || !fs.existsSync(f)) return;
  try {
    state = migrate(JSON.parse(fs.readFileSync(f, "utf8")));
  } catch (e) {
    // Never overwrite a file we could not read: move it aside and start clean.
    const aside = `${f}.corrupt-${Date.now()}`;
    fs.renameSync(f, aside);
    console.error(JSON.stringify({ level: "error", event: "state_corrupt", moved_to: aside, error: e.message }));
    state = defaults();
  }
}

function persist(next) {
  const f = file();
  if (!f) return;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

// Commit a new state only if it persisted. On failure, memory is left unchanged.
function commit(next) {
  persist(next);
  state = next;
}

export function get() { return state; }

export function update(patch) {
  commit({ ...state, ...patch });
  return state;
}

export function patch(section, value) {
  commit({ ...state, [section]: { ...state[section], ...value } });
  return state[section];
}

// Test helper: replace everything with a migrated partial state. Not used in routes.
export function resetState(partial = {}) {
  state = migrate(partial);
}

export function redacted() {
  const s = state;
  return {
    gateway: s.gateway,
    external: {
      services: s.external.services.map(({ token, ...rest }) => ({
        ...rest,
        hasToken: Boolean(token),
        scheme: inferScheme(rest.endpoint)
      })),
      lastTest: null
    },
    codebase: {
      repoUrl: s.codebase.repoUrl,
      fullName: s.codebase.fullName,
      defaultBranch: s.codebase.defaultBranch,
      hasToken: Boolean(s.codebase.token),
      commits: s.codebase.commits,
      connectedAt: s.codebase.connectedAt
    },
    safety: s.safety,
    monitoring: s.monitoring
  };
}
