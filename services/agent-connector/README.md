# Sleepy Bot — Agent Connector (rollback architecture)

Read-only integration service called by **Agent Core**. In the current architecture, Agent Connector connects to only three monitored dependencies:

- Database
- Authentication service
- Other third-party API(s)

The Client calls the `Middleware: sleepy_bot` layer. Middleware routes agent work to Agent Core. Agent Core calls this connector over HTTP when it needs dependency diagnostics. The application Server, Codebase, CI/CD pipeline, Developer Team and Notification components are separate components and are deliberately not implemented inside this connector.

## Responsibilities and boundaries

- Expose a discoverable catalogue of read-only diagnostic tools.
- Retrieve health, metrics and logs from database, auth and external API integrations.
- Validate common response contracts and return normalized evidence.
- Support mock incident scenarios for development and demos.
- Never change infrastructure, restart services, deploy code, or execute remediation.
- Never call the Core Agent or an LLM. Agent Core is the caller.

## Requirements

- Node.js 20+
- npm

## Setup

```bash
npm install
cp .env.example .env
```

Set `CONNECTOR_API_TOKEN` in `.env` to a unique random value of at least 32 characters. Keep `.env` private and do not commit it. Start in mock mode:

```bash
npm run dev
```

The service listens on `http://localhost:4100` by default.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

## API for Agent Core

All `/connector/*` routes require `Authorization: Bearer <CONNECTOR_API_TOKEN>`.

### Health (connector's own liveness)

```http
GET /health
```

### Discover tools

```http
GET /connector/tools
GET /connector/tools?format=openai
```

The native catalogue includes tool names, descriptions, input schemas, read permission and output descriptions. `format=openai` returns function-tool definitions suitable for providers that accept OpenAI-style `tools` arrays. Agent Core remains responsible for deciding which tools to call and interpreting evidence.

### Execute one tool

```http
POST /connector/execute
Content-Type: application/json

{"tool":"inspect_database_health","arguments":{}}
```

Available tools:

- `inspect_database_health`, `inspect_database_metrics`, `inspect_database_logs`
- `inspect_auth_health`, `inspect_auth_metrics`, `inspect_auth_logs`
- `inspect_external_api_health`, `inspect_external_api_metrics`, `inspect_external_api_logs`

### Batch investigation

```http
POST /connector/investigate
Content-Type: application/json

{"services":["database","auth","external_api"]}
```

The connector runs supported checks with bounded concurrency and returns individual results plus a status summary. Partial failures are represented per check; one unreachable dependency does not erase other results.

### Mock scenario controls

These routes are available only when `CONNECTOR_MODE=mock`:

```http
GET /connector/demo/scenario
POST /connector/demo/scenario
Content-Type: application/json

{"scenario":"database_failure"}
```

Scenarios: `normal`, `database_failure`, `external_api_failure`.

## Live integration contract

Set `CONNECTOR_MODE=live` and configure the relevant `*_BASE_URL` variables. The default endpoint paths are shown in `.env.example`. Each service should return JSON:

Health:
```json
{"service":"database","status":"healthy","timestamp":"2026-11-12T12:00:00.000Z","checks":{"connectivity":"healthy"}}
```

Metrics:
```json
{"service":"database","timestamp":"2026-11-12T12:00:00.000Z","metrics":{"active_connections":32,"max_connections":100}}
```

Logs:
```json
{"service":"database","timestamp":"2026-11-12T12:00:00.000Z","logs":[{"timestamp":"2026-11-12T12:00:00.000Z","level":"error","message":"Example failure","source":"database"}]}
```

The connector validates response shape. A missing or unreachable endpoint is reported as `unreachable`, never as healthy. Use read-only credentials for every monitored integration. Do not include passwords, tokens, session cookies, or personal data in logs.

## Docker

```bash
docker compose up --build
```

When Agent Core runs in the same Compose network, call the connector using its Compose service DNS name (for example `http://agent-connector:4100`), not `localhost`.

## Security notes

- Bearer-token authentication protects connector routes.
- Helmet, CORS allowlisting, JSON body limits and rate limiting are enabled.
- Tool names are allowlisted; arbitrary URLs, shell commands and write operations are not accepted from Agent Core.
- Integration credentials are configured server-side and are never returned by tool discovery.
- Keep mock scenario controls disabled in live mode (enforced by the route handler).

## Project layout

```text
src/
  adapters/       # Mock and live dependency adapters
  contracts/      # Zod diagnostic response contracts
  lib/            # HTTP and normalized result helpers
  middleware/     # Bearer authentication
  registry/       # Agent-callable tool catalogue
  routes/         # Connector HTTP endpoints
  services/       # Tool execution and batch investigation
  app.ts
  config.ts
  server.ts
```
