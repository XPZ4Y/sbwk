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

## Lazy two-stage gate (`DETECT_MODE=batch`, opt-in)

By default (`DETECT_MODE=immediate`, or the variable unset) the middleware behaves
exactly as described above: every detected anomaly is dispatched as it happens.
Nothing about that path changed.

`DETECT_MODE=batch` turns the middleware into stage one of a lazy two-stage gate:

1. **Buffer, don't page.** A bad request (still classified by `classifyStatus`, so
   `DETECT_STATUS_MIN`, `DETECT_SLOW_MS` and `DETECT_UPSTREAM_ERRORS` keep their
   meaning) goes into a bounded ring buffer (`BATCH_MAX_SIZE`). No AI-shaped work
   happens — no connector, no LLM, no notification.
2. **Wake on a pattern, not a request.** When `BATCH_MIN_BAD` bad requests land
   inside `BATCH_WINDOW_MS`, the buffer flushes **once**: `POST /incidents/batch`
   on Agent Core with a compact log digest (counts by category/status, top paths,
   a few samples) plus the raw incidents.
3. **Liquid decides if it matters.** Agent Core asks Liquid `d1` one `noul`
   question about the digest. *Not anomalous* → the incidents are stored as
   `skipped` with a synthetic "Liquid says normal" analysis (no Groq, no
   notification, no cost). *Anomalous* → every buffered incident runs through the
   **existing** per-incident investigator, unchanged.
4. **A broken gate never drops signal.** If the batch endpoint is unreachable,
   `LIQUID_BATCH_FALLBACK=investigate` (default) replays each incident through the
   normal `dispatchIncident` path — a real agent still sees it. `skip` accepts the
   miss and logs it at `error`.

Because the incidents were already de-duplicated by `DispatchThrottle` before
buffering, `DISPATCH_COOLDOWN_MS` keeps working exactly as it did.

### The dumb activation function (`activation.mjs`)

The wake condition is deliberately stupid: a handful of comparisons you can
predict, with all the expensive intelligence sitting *behind* it. Two rules:

| rule | what it does | default |
| --- | --- | --- |
| **IMPULSE** | ONE severe bad request skips the "wait for a pattern" step. Severe = 5xx, unreachable/timed-out upstream, a repeat failure on the same path, or slower than `BATCH_IMPULSE_SEVERE_MS`. | `on` |
| **TRIVIAL** | Known noise is answered locally instead of spending a Liquid call on it: scanner paths (`/.env`, `/wp-login.php`, `/phpmyadmin`…), `favicon.ico`/`robots.txt` probes, and plain `401`/`403` client auth mistakes. Only when *every* incident in the batch is trivial — one real incident disables it. Never applies to 5xx or upstream failures. | `off` |

So in `batch` mode a single unexplained 500 still wakes the agent immediately
(it is 5xx), while five requests to `/.env` are quietly marked "known noise" and
cost nothing. Turn `BATCH_IMPULSE=false` if you want *only* the count threshold,
and set `BATCH_SKIP_TRIVIAL=true` to stop paying for script-kiddie traffic.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DETECT_MODE` | `immediate` | `immediate` = today's behaviour; `batch` = opt in to the gate |
| `BATCH_IMPULSE` | `true` | Let one severe request self-activate the gate |
| `BATCH_IMPULSE_SEVERE_MS` | `5000` | A response this slow counts as severe |
| `BATCH_SKIP_TRIVIAL` | `false` | Answer recognised noise locally (no Liquid call) |
| `BATCH_MIN_BAD` | `5` | Bad requests needed to wake the agent |
| `BATCH_WINDOW_MS` | `60000` | The window that count is measured over |
| `BATCH_MAX_SIZE` | `50` | Bounded ring buffer size (overflow is counted, never grown) |
| `BATCH_FLUSH_TIMEOUT_MS` | `0` | Optional trickle drain; `0` = only a threshold crossing wakes the agent |
| `BATCH_SWEEP_MS` | `1000` | How often the window is re-evaluated (no I/O) |
| `BATCH_TIMEOUT_MS` | `25000` | Timeout for the whole batch round trip |
| `LIQUID_BATCH_FALLBACK` | `investigate` | Batch endpoint down → `investigate` (keep signal) or `skip` |

The digest is built by the pure `digest.mjs` helpers, the wake rules live in
`activation.mjs`, and the ring buffer lives in `batch-buffer.mjs`; `GET /_sbwk/batch` exposes the buffer state, and
`POST /_sbwk/batch/flush` forces a flush (demo/debug aid; a no-op in immediate
mode). `node --test` and `node demo/run-batch-demo.mjs` cover both modes.

## Admin API

All `/_sbwk/*` routes require `Authorization: Bearer <MIDDLEWARE_ADMIN_TOKEN>`.

```http
GET /health                 # liveness (no auth)
GET /_sbwk/status           # config + incident counts + batch buffer state
GET /_sbwk/incidents?limit=50
GET /_sbwk/logs?limit=100   # recent proxied requests
GET /_sbwk/batch            # batch buffer state + last flush outcome
POST /_sbwk/batch/flush     # force a flush (no-op in immediate mode)
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
config.mjs        # env config (+ optional .env loader)
detector.mjs      # status classification, throttle, incident builder
digest.mjs        # compact log digest of a batch (pure)
activation.mjs    # dumb activation: impulse (one severe event) + trivial (noise)
batch-buffer.mjs  # lazy batch gate: bounded ring buffer + wake condition
server.mjs        # node:http reverse proxy + detection hooks + admin routes
test/             # node --test
```
