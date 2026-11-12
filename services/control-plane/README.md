# Sleepy Bot — Control Plane (Developer Onboarding)

Serves the onboarding UI (`public/index.html`) and makes **every step real** — no
fake `setTimeout` validations. Zero-dependency Node.js.

## What each step actually does

| Step | UI action | Real backend behavior |
| --- | --- | --- |
| **01 Gateway** | Save target URL/port + "check gateway" | Persists config, pushes the target to the middleware (`POST /_sbwk/config`), and runs a **real reachability request** to the target |
| **02 External** | "Test connections" | Persists auth/DB endpoints + read-only key, runs **real reachability checks** (HTTP request, or DNS probe for `mongodb+srv` etc.), and pushes HTTP endpoints to the connector |
| **03 Codebase** | "Connect repository" | Calls the **real GitHub API** for repo metadata + the **last 5 commits**, stores them, and pushes them to Agent Core so diagnosis correlates recent commits with failing requests |
| **04 Safety** | Toggles + "Start monitoring" | Persists dry-run / auto-rollback / **80% escalation threshold** and pushes them to Agent Core; "Start monitoring" flips the real monitoring switch and shows a live incident feed |

Secrets (API key, GitHub token) are stored server-side and **never returned** by the
API. The UI only sees `hasApiKey` / `hasToken` flags.

## Requirements

- Node.js 20+ (no other dependencies)

## Run

```bash
cp .env.example .env     # optional
node server.mjs          # http://localhost:4300
```

Open `http://localhost:4300` for the onboarding UI. It expects the middleware,
agent-core and connector to be running (see the repo-root `demo/run-stack.mjs` or
`docker compose up`).

## Verification

```bash
node --test
```

## API

```http
GET  /                      # onboarding UI
GET  /api/state             # redacted config + downstream service health
POST /api/gateway           # {targetUrl, port}
POST /api/gateway/check     # real reachability of the saved target
POST /api/external          # {authEndpoint, apiKey, databaseEndpoint}
POST /api/external/test     # real connection tests -> {auth, database, reachable}
POST /api/codebase          # {repoUrl, token} -> real GitHub metadata + 5 commits
POST /api/safety            # {dryRun, autoRollback, escalationThreshold}
POST /api/monitoring/start  # activate the agent
POST /api/monitoring/stop   # pause the agent
GET  /api/incidents         # live incident feed (proxied from agent-core)
```

## Notes & boundaries

- **Read-only agent.** Dry-run is the enforced reality: the agent suggests fixes and
  never executes them. `autoRollback` is recorded as a policy flag for a future
  execution engine; nothing is applied, so nothing is rolled back in this prototype.
- **External DB checks.** HTTP endpoints get a real request; non-HTTP connection
  strings (e.g. `mongodb+srv://`) get a DNS-level reachability probe. A full protocol
  handshake would require a database driver (future work).
- **Security.** This is a local prototype; the API is unauthenticated for ease of
  onboarding. Put it behind authentication / a private network before exposing it.

## Project layout

```text
config.mjs   # env config
store.mjs    # onboarding state (secrets redacted in API responses)
checks.mjs   # real reachability + GitHub API
apply.mjs    # push config to middleware / connector / agent-core
server.mjs   # node:http server + onboarding API + serves the UI
public/      # the onboarding UI (rewired to call the real API)
test/        # node --test
```
