# Sleepy Bot — Middleware (the Edge)

The SBWK edge layer. Clients hit the middleware instead of the application
Server. The middleware transparently reverse-proxies every request to the Server
(like a tiny Cloudflare), watches each response, and — when it detects an anomaly
(HTTP 500/502/503/504, optionally 4xx like 404, or an unreachable/timed-out
upstream) — asynchronously dispatches an **incident** to **Agent Core**.

Zero-dependency Node.js: the proxy is built on the standard `node:http`/`node:https`
modules (no Express, no proxy library). The client response is never blocked on the
agent: detection and dispatch happen off the response path, and identical anomalies
are de-duplicated within a cooldown window.

## Responsibilities and boundaries

- Reverse-proxy Client → Server, preserving method, headers, query and body.
- Detect anomalous responses and upstream failures.
- Capture a bounded sample of the error body as evidence.
- Dispatch incidents to Agent Core over HTTP (bearer-authenticated).
- Expose read-only admin endpoints for observability.
- Never inspect dependencies, call an LLM, or remediate — that is Agent Core's job.

## Requirements

- Node.js 20+ (no other dependencies)

## Setup

```bash
cp .env.example .env     # optional
node server.mjs
```

Listens on `http://localhost:8080` and proxies to `TARGET_SERVER_URL`
(default `http://localhost:8000`). Auto-reload in dev: `node --watch server.mjs`.

## Verification

```bash
node --test
```

## Configuration

See `.env.example`. Key settings:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TARGET_SERVER_URL` | `http://localhost:8000` | Application Server to proxy to |
| `AGENT_CORE_URL` | `http://localhost:4200` | Where incidents are dispatched |
| `AGENT_CORE_TOKEN` | dev token | Shared secret with Agent Core (>= 32 chars) |
| `MIDDLEWARE_ADMIN_TOKEN` | dev token | Protects `/_sbwk/*` admin endpoints |
| `DETECT_STATUS_MIN` | `500` | Flag responses with status >= this. Set `400` to also catch 404 |
| `DETECT_UPSTREAM_ERRORS` | `true` | Dispatch on unreachable/timed-out upstream |
| `DISPATCH_COOLDOWN_MS` | `15000` | De-dup window per method+path+status |
| `RESPONSE_SAMPLE_BYTES` | `2048` | Max error-body bytes captured as evidence |

## Admin API

All `/_sbwk/*` routes require `Authorization: Bearer <MIDDLEWARE_ADMIN_TOKEN>`.

```http
GET /health                 # liveness (no auth)
GET /_sbwk/status           # config + incident counts
GET /_sbwk/incidents?limit=50
```

## Incident payload (sent to Agent Core `POST /incidents`)

```json
{
  "id": "uuid",
  "requestId": "uuid",
  "source": "middleware",
  "detectedAt": "2026-11-12T12:00:00.000Z",
  "method": "GET",
  "path": "/users",
  "query": "id=42",
  "statusCode": 500,
  "durationMs": 12.35,
  "upstream": "http://server:80",
  "category": "server_error",
  "reason": "Upstream returned server error HTTP 500",
  "responseSample": "...bounded error body...",
  "clientIp": "203.0.113.7",
  "userAgent": "curl/8.0"
}
```

## Docker

```bash
docker compose up --build
```

The image is `node:22-alpine` plus the `.mjs` source — no install layer. In the
Compose network, set `TARGET_SERVER_URL=http://server:80` and
`AGENT_CORE_URL=http://agent-core:4200` (service DNS names, not `localhost`).

## Project layout

```text
config.mjs     # env config (+ optional .env loader)
detector.mjs   # status classification, throttle, incident builder
server.mjs     # node:http reverse proxy + detection hooks + admin routes
test/          # node --test
```
