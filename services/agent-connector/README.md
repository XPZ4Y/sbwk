# Sleepy Bot — Agent Connector

A read-only integration microservice that allows Agent Core to inspect application infrastructure and retrieve diagnostic evidence.

## Responsibilities

- Exposes a tool catalogue to Agent Core.
- Executes allowlisted, read-only diagnostic tools.
- Connects to server, database-monitor, authentication, external API, Git and CI/CD interfaces.
- Normalizes results into a common evidence format.
- Handles timeouts, unreachable services and partial failures.
- Supports mock mode for development and demonstrations.

It does **not** diagnose root causes, approve actions, restart services, change configuration or roll back deployments. Those responsibilities belong to Agent Core and the separate safety/remediation module.

## Requirements

- Node.js 20+
- npm

## Run locally

```bash
npm install
cp .env.example .env
```

Set a strong `CONNECTOR_API_TOKEN` in `.env`.

Start in mock mode:

```bash
npm run dev
```

The service listens on `http://localhost:4100`.

## Authentication

All `/connector/*` endpoints require:

```http
Authorization: Bearer YOUR_CONNECTOR_API_TOKEN
```

The public `/health` endpoint is intentionally unauthenticated for container health checks.

## Endpoints

### `GET /health`

Liveness check. No authentication required.

### `GET /connector/status`

Returns connector mode, read-only status and supported services.

### `GET /connector/tools`

Returns the registered diagnostic tool catalogue.

### `POST /connector/execute`

Execute one allowlisted diagnostic tool.

Example:

```json
{
  "tool": "inspect_database_health",
  "arguments": {}
}
```

### `POST /connector/investigate`

Run all supported checks for selected services concurrently with a concurrency limit.

Example:

```json
{
  "services": ["server", "database", "auth", "external_api", "codebase", "cicd"]
}
```

Individual integration failures are returned as evidence results; one unavailable service does not fail the entire investigation.

## Switch to live integrations

Set:

```env
CONNECTOR_MODE=live
```

Configure the base URLs and paths in `.env`. The monitored services must expose the read-only endpoints listed in `.env.example`.

The connector does not assume those endpoints exist. Coordinate their exact paths and response formats with the infrastructure owner.

### Expected endpoint examples

| Service | Endpoint | Purpose |
|---|---|---|
| Server | `GET /internal/health` | Server health |
| Server | `GET /internal/metrics` | Server metrics |
| Server | `GET /internal/logs` | Recent logs |
| Database monitor | `GET /internal/health` | Database health |
| Database monitor | `GET /internal/metrics` | Database metrics |
| Auth | `GET /internal/health` | Auth health |
| Auth | `GET /internal/metrics` | Auth metrics |
| Auth | `GET /internal/logs` | Auth logs |
| External API | `GET /health` | Dependency health |
| External API | `GET /metrics` | Dependency metrics |
| CI/CD | Configured deployments path | Deployment history |

All integration endpoints should return JSON. Keep their response contracts documented and avoid returning credentials or personal data.

### Git integration

Set `GIT_REPOSITORY_PATH` to a local, read-only checkout available to the connector process. The connector runs a fixed `git log` command; it does not accept shell commands or user-supplied Git arguments.

### CI/CD integration

Set `CICD_BASE_URL`, `CICD_DEPLOYMENTS_PATH` and a read-only `CICD_API_TOKEN` if required by your provider.

## Docker

```bash
cp .env.example .env
docker compose up --build
```

If running in Docker Compose, service URLs must use Compose service names, not `localhost`, when the target services are in the same Compose network.

## Test

```bash
npm test
npm run typecheck
npm run build
```

## Example cURL requests

```bash
curl http://localhost:4100/health
```

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:4100/connector/tools
```

```bash
curl -X POST http://localhost:4100/connector/investigate \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"services":["server","database","auth","external_api","codebase","cicd"]}'
```

## Integration contract for Agent Core

Agent Core should:

1. Call `GET /connector/tools` to discover available tools.
2. Call `POST /connector/execute` for one tool, or `POST /connector/investigate` for a batch of service checks.
3. Treat `healthy`, `degraded`, `unhealthy`, `unreachable` and `unknown` as distinct states.
4. Use `evidence`, `data`, `source`, `observedAt` and `error` when reasoning.
5. Never treat a connector timeout as proof that the target service itself is down.

## Security notes

- Use a long, unique connector token and rotate it.
- Keep `.env` out of Git.
- Use read-only credentials for monitored services.
- Do not expose database rows, passwords, tokens or secrets in diagnostic responses.
- Keep the connector on a private network where possible.
- Add TLS or terminate TLS at a trusted reverse proxy in shared environments.
- The mock mode is for development/demo only.
- This connector is diagnostic-only; remediation must go through the separate safety-controlled module.
