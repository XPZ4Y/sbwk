# Sleepy Bot — Agent Core (the Brain)

Agent Core receives anomaly **incidents** from the Middleware, investigates them,
reasons about the root cause, suggests fixes, retains context across incidents,
and wakes a human engineer when it cannot confidently resolve the problem.

Zero-dependency Node.js (built-in `http`/`fetch` only) — no `npm install`, no build
step. It is the only component that calls the **Agent Connector** (read-only
dependency diagnostics) and the **LLM**. It is strictly read-only: it never
restarts services, deploys code, or executes remediation — it only suggests.

## Investigation pipeline

For each incident, Agent Core:

1. **Gathers dependency evidence** from the Agent Connector
   (`POST /connector/investigate`) for database, auth and external API.
2. **Inspects the codebase** (read-only) for source relevant to the failing route
   and error, returning small snippets.
3. **Triages with Liquid AI `d1`** (`liquid.mjs`): the incident context is sent to
   `POST /decisions/v1/systemone` as a `state` plus `department` (choice),
   `is_urgent` (noul) and `frustration` (score) questions. A pure policy function
   turns those answers into one of two routes:
   - `engineer` → wake a human, **skip the LLM entirely** (mode `engineer`);
   - `groq` → continue to step 4.

   With no `LIQUID_API_KEY` the route is `groq` by default (a notice, not an
   error). If Liquid is configured but the call fails, the incident still falls
   back to Groq and the failure is attached to the analysis as a red warning.
4. **Reasons** about root cause:
   - `AGENT_MODE=live` → Groq LLM (OpenAI-compatible chat API), or
   - `AGENT_MODE=mock` → a deterministic, dependency-first heuristic reasoner.
   - Live mode transparently falls back to the heuristic if the LLM is unavailable.
5. **Suggests fixes** (config / code / dependency / investigation), optionally
   with a unified `diff` that the control plane renders line-by-line.
6. **Retains context** and recognises recurring failures on the same path.
7. **Escalates** via Notification (structured log + optional webhook) when
   confidence is low, a dependency/server is unreachable, severity is critical,
   or the failure is recurring. Engineers can also mark an incident `unresolved`
   to trigger escalation.

## Requirements

- Node.js 20+ (no other dependencies)

## Setup

```bash
cp .env.example .env     # optional
node server.mjs
```

Listens on `http://localhost:4200`. Mock mode needs no API key. For live reasoning
set `AGENT_MODE=live` and `GROQ_API_KEY`. Auto-reload in dev: `node --watch server.mjs`.

## Verification

```bash
node --test
```

## API

All `/incidents/*` routes require `Authorization: Bearer <AGENT_CORE_TOKEN>`.

```http
GET /health                      # liveness (no auth)

POST /incidents                  # receive an incident from the Middleware (202)
POST /incidents?wait=true        # same, but block until the analysis is ready (200)
GET  /incidents?limit=50         # recent incidents + context summary
GET  /incidents/:id              # one incident with its analysis
GET  /incidents/context          # retained-context summary
POST /incidents/:id/feedback     # {"status":"resolved|unresolved","note":"..."}
GET  /config                     # current runtime config (no secrets)
POST /config                     # {liquid,llm,safety,...} — see "Prompt engineering"
POST /incidents?test=true        # run a synthetic incident, store nothing, notify nobody
```

By default `POST /incidents` returns `202` immediately and investigates in the
background; poll `GET /incidents/:id`. Use `?wait=true` for a synchronous `200`
with the full analysis (handy for demos and tests).

### Analysis shape

```json
{
  "incidentId": "uuid",
  "mode": "mock",
  "severity": "high",
  "summary": "Request failed because the database dependency is unhealthy.",
  "rootCause": { "summary": "...", "confidence": 0.82 },
  "confidence": 0.82,
  "suggestedFixes": [ { "title": "...", "description": "...", "kind": "dependency", "file": "..." } ],
  "dependencyFindings": [ { "service": "database", "status": "unhealthy", "signals": ["..."] } ],
  "codeFindings": [ { "file": "server.mjs", "line": 18, "snippet": "...", "reason": "..." } ],
  "escalate": false,
  "escalationReason": null,
  "reasoning": "...",
  "recurring": 0,
  "routing": {
    "provider": "liquid", "model": "d1", "route": "groq", "ok": true,
    "status": "routed", "skipped": false,
    "reasons": ["Liquid d1: technical diagnosis is appropriate (...)"],
    "decision": { "department": "technical", "urgencyProbability": 0.93, "frustrationScore": 1.2, "frustrationLabel": "Frustrated" },
    "warnings": [], "latencyMs": 184
  },
  "warnings": [],
  "prompt": { "profile": "balanced", "temperature": 0.2, "maxTokens": 4000, "isCustom": false },
  "aiDebug": [ { "provider": "groq", "ok": true, "request": {...}, "response": {...} } ],
  "createdAt": "2026-11-12T12:00:00.000Z"
}
```

`mode` is now one of `live` (Groq answered), `mock` (heuristic fallback) or
`engineer` (Liquid routed to a human; no LLM ran). `warnings[]` uses
`severity: "error"` for a broken API call and `"notice"` for configuration gaps;
the control plane paints the former red.

## Prompt engineering

`prompts.mjs` ships five profiles — `balanced`, `concise`, `diff_first`,
`strict_json`, `sre_checklist` — each with its own system prompt, user template,
temperature and `max_tokens`. Templates accept `{{incident}}`, `{{evidence}}`,
`{{dependencyFindings}}`, `{{codeFindings}}`, `{{recentCommits}}`,
`{{recurring}}`, `{{repoUrl}}`, `{{liquid}}` and `{{tools}}`.

Change strategy without redeploying:

```bash
curl -X POST localhost:4200/config -H "Authorization: Bearer $AGENT_CORE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"llm":{"profile":"diff_first","temperature":0.4,"maxTokens":3000}}'

# or a fully custom system prompt
curl -X POST localhost:4200/config … -d '{"llm":{"systemPrompt":"..."}}'

# back to the profile defaults
curl -X POST localhost:4200/config … -d '{"llm":{"reset":true}}'

# measure the change on a synthetic incident (nothing persisted, nobody paged)
curl -X POST "localhost:4200/incidents?test=true&wait=true" …
```

Agent Core prints one debug JSON line per AI call (`liquid_triage` details are
in the analysis' `routing` block; Groq calls log as `groq_ai_call`), with the
`Authorization` header redacted.

## Configuration

See `.env.example`. Key settings:

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_CORE_TOKEN` | dev token | Shared secret with the Middleware (>= 32 chars) |
| `AGENT_MODE` | `mock` | `mock` heuristic or `live` Groq reasoning |
| `GROQ_API_KEY` | — | Required for live mode |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Groq model |
| `GROQ_PROMPT_PROFILE` | `balanced` | Prompt strategy (`balanced`, `concise`, `diff_first`, `strict_json`, `sre_checklist`) |
| `GROQ_SYSTEM_PROMPT` / `GROQ_PROMPT_TEMPLATE` | — | Full prompt overrides (win over the profile) |
| `GROQ_TEMPERATURE` / `GROQ_MAX_TOKENS` | profile defaults | Sampling per profile |
| `LIQUID_API_KEY` | — | Enables the d1 triage router; unset → always Groq |
| `LIQUID_MODEL` / `LIQUID_BASE_URL` | `d1` / `https://api.liquid.ai` | Endpoint under test or a local stub |
| `LIQUID_TIMEOUT_MS` | `8000` | Triage budget before falling back to Groq |
| `LIQUID_MAX_STATE_CHARS` | `6000` | Cap on the context string sent to d1 |
| `LIQUID_ENABLED` | `true` | Keep the key but bypass d1 |
| `LIQUID_ROUTE_POLICY` | see `liquid.mjs` | JSON thresholds / engineer departments |
| `LIQUID_QUESTIONS` | see `liquid.mjs` | JSON override of the d1 question set |
| `AI_DEBUG` | `true` | Attach the AI call records to each analysis |
| `CONNECTOR_URL` | `http://localhost:4100` | Agent Connector base URL |
| `CONNECTOR_API_TOKEN` | dev token | Shared secret with the connector |
| `CODEBASE_PATH` | — | Read-only source tree to inspect |
| `ESCALATION_CONFIDENCE_THRESHOLD` | `0.5` | Below this confidence, escalate |
| `NOTIFICATION_WEBHOOK_URL` | — | Optional webhook (e.g. Slack); always logged |
| `DATA_DIR` | — | Persist context here (empty = in-memory) |

## Docker

```bash
docker compose up --build
```

The image is `node:22-alpine` plus the `.mjs` source — no install layer. In the
Compose network use `CONNECTOR_URL=http://agent-connector:4100`. Mount your
application source read-only at `CODEBASE_PATH` so the agent can inspect it.

## Project layout

```text
config.mjs       # env config (+ optional .env loader)
store.mjs        # context retention (in-memory + optional disk)
codebase.mjs     # read-only codebase inspector
liquid.mjs       # Liquid d1 triage: state builder, questions, routing policy
prompts.mjs      # prompt profiles, resolution order, {{variable}} templating
ai-debug.mjs     # redacted, structured debug JSON for every AI call
reason.mjs       # findings, heuristic reasoner, Groq reasoner, selector
notify.mjs       # Notification -> Developer Team (webhook + log)
investigate.mjs  # triage -> reason -> escalate orchestration (injectable deps)
server.mjs       # node:http server + incident routes + bearer auth
test/            # node --test
```
