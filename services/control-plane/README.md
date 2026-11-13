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

## Troubleshooting

### `save failed: could not save: EACCES: permission denied, open '/data/onboarding.json.tmp'`

The control plane writes onboarding state to `DATA_DIR` (`/data` in Compose) with
an atomic temp-file + rename. The data dir is a **named volume**, which Docker
creates as `root:root 0755` — but the app runs as `node` (uid 1000), so creating
`onboarding.json.tmp` fails. Nothing is wrong with your GitHub token; the request
never got that far (the GitHub link is fetched and verified *before* the write).

**Fix an existing install (one command):**

```bash
docker compose run --rm --user root --entrypoint sh control-plane \
  -c 'chown -R node:node /data && ls -ln /data'
docker compose up -d control-plane
```

Or repair the volume directly:

```bash
docker volume ls | grep control-plane          # find the real name, e.g. sbwk_control-plane-data
docker run --rm -v sbwk_control-plane-data:/data alpine chown -R 1000:1000 /data
```

**Prevention is built in:** the image entrypoint starts as root, chowns
`DATA_DIR` to the runtime user, then drops privileges with `su-exec` — so a
correct volume costs one `stat`, and an already-broken one heals on the next
`docker compose up` (look for `"event":"data_dir_chowned"` in the logs).

Two guards make the failure loud instead of cryptic:

* at boot the control plane probes the directory and logs
  `data_dir_not_writable` with the exact `chown` to run; `GET /api/state` reports
  `dataDir: { path, status: "ok" | "reclaimed" | "readonly" }`.
* a failed save now says `DATA_DIR '/data' is not writable by this process
  (running as uid 1000). Fix it with: …` instead of naming a `.tmp` file.
  The original errno is preserved as `error.code` (`EACCES`, `EROFS`, …).

`agent-core` mounts `agent-core-data` the same way and shares the entrypoint; it
previously swallowed the same failure silently (context never persisted across
restarts) and now logs `state_persist_failed` once per errno.

