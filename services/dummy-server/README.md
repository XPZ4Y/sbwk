# Sleepy Bot — Dummy Server

A tiny, **zero-dependency** stand-in for "your application Server". It replaces the
~200 MB `kennethreitz/httpbin` image in the SBWK stack.

Because it is plain Node.js on `node:22-alpine` — the **same base image** as the
middleware, agent-core and connector — it adds **no extra base-image pull**. The
httpbin image, by contrast, is a separate ~200 MB Python image.

## Endpoints

| Route | Behavior |
| --- | --- |
| `GET /` | service info |
| `GET /health` | liveness |
| `GET /users` | reads a simulated database (500 when `failMode=database`) |
| `GET /external` | calls a simulated third-party API (503 when `failMode=external`) |
| `GET /status/:code` | returns that HTTP status (httpbin-compatible, e.g. `/status/500`) |
| `GET /delay/:seconds` | responds after a delay (max 10s) — for slow-response detection |
| `POST /_control {"mode":"normal\|database\|external"}` | flip the failure mode |
| anything else | `404` |

## Run

```bash
node server.mjs        # :8000
```

## Even lighter standalone alternatives

If you want a standalone dummy image instead of building this one:

- **`mccutchen/go-httpbin`** (~4.3 MB) — a zero-dependency Go port of httpbin with
  `/status/:code`, `/delay/:n`, etc. A near drop-in. Use the provided
  `docker-compose.httpbin-lite.yml` override at the repo root.
- **`traefik/whoami`** (~2.9 MB) — tiny, but always returns 200 (reachability only,
  no failure injection).

This custom dummy server is preferred for SBWK because it also exposes the
`/_control` failure-injection and app-like routes used by the demo and onboarding.
