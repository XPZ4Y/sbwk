# Sleepy Bot — Agent Connector (the Hands)

Read-only integration service called by **Agent Core**. Zero-dependency Node.js
(built-in `http`/`fetch` only) — no `npm install`, no build step. It connects to
three monitored dependencies:

- Database
- Authentication service
- Other third-party API(s)

Agent Core calls this connector over HTTP when it needs dependency diagnostics.
The application Server, Codebase, CI/CD, Developer Team and Notification are
separate components and are deliberately not implemented here.

## Responsibilities and boundaries

- Expose a discoverable catalogue of read-only diagnostic tools.
- Retrieve health, metrics and logs from database, auth and external API integrations.
- Validate response contracts and return normalized evidence.
- Support mock incident scenarios for development and demos.
- Never change infrastructure, restart services, deploy code, or execute remediation.
- Never call the Core Agent or an LLM. Agent Core is the caller.

## Requirements

- Node.js 20+ (no other dependencies)

## Setup

```bash
cp .env.example .env     # optional; otherwise environment variables are used
node server.mjs
```

Set `CONNECTOR_API_TOKEN` to a unique random value of at least 32 characters.
The service listens on `http://localhost:4100` by default. Auto-reload in dev:
`node --watch server.mjs`.

## Verification

```bash
node --test
```

## API for Agent Core

All `/connector/*` routes require `Authorization: Bearer <CONNECTOR_API_TOKEN>`.

```http
GET /health                              # connector liveness (no auth)
GET /connector/tools                     # native tool catalogue
GET /connector/tools?format=openai       # OpenAI-style function tools
GET /connector/status                    # mode + available services

POST /connector/execute                  # {"tool":"inspect_database_health","arguments":{}}
POST /connector/investigate              # {"services":["database","auth","external_api"]}
```

Available tools (read-only, no arguments):

- `inspect_database_health`, `inspect_database_metrics`, `inspect_database_logs`
- `inspect_auth_health`, `inspect_auth_metrics`, `inspect_auth_logs`
- `inspect_external_api_health`, `inspect_external_api_metrics`, `inspect_external_api_logs`

`/connector/investigate` runs supported checks with bounded concurrency and returns
individual results plus a status summary. One unreachable dependency does not
erase other results.

### Mock scenario controls (only when `CONNECTOR_MODE=mock`)

```http
GET  /connector/demo/scenario
POST /connector/demo/scenario            # {"scenario":"database_failure"}
```

Scenarios: `normal`, `database_failure`, `external_api_failure`.

## Live integration contract

Set `CONNECTOR_MODE=live` and configure the relevant `*_BASE_URL` variables (see
`.env.example`). Each service should return JSON:

```json
// health
{"service":"database","status":"healthy","timestamp":"2026-11-12T12:00:00.000Z","checks":{"connectivity":"healthy"}}
// metrics
{"service":"database","timestamp":"2026-11-12T12:00:00.000Z","metrics":{"active_connections":32,"max_connections":100}}
// logs
{"service":"database","timestamp":"2026-11-12T12:00:00.000Z","logs":[{"timestamp":"2026-11-12T12:00:00.000Z","level":"error","message":"Example failure","source":"database"}]}
```

The connector validates response shape. A missing or unreachable endpoint is
reported as `unreachable`, never as healthy. Use read-only credentials. Do not
include passwords, tokens, session cookies, or personal data in logs.

## Docker

```bash
docker compose up --build
```

The image is `node:22-alpine` plus the `.mjs` source — no install layer. In the
Compose network, call the connector by its service DNS name
(`http://agent-connector:4100`), not `localhost`.

## Security notes

- Bearer-token authentication protects connector routes.
- Tool names are allowlisted; arbitrary URLs, shell commands and write operations
  are not accepted from Agent Core.
- Integration credentials are configured server-side and never returned by discovery.
- Mock scenario controls are disabled in live mode.

## Project layout

```text
config.mjs     # env config (+ optional .env loader)
mock.mjs       # mock scenarios + mock diagnostics
adapters.mjs   # tool catalogue, live/mock inspection, batch investigation
server.mjs     # node:http server + routes + bearer auth
test/          # node --test
```
