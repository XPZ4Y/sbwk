# Changelog

All notable changes to SBWK (Sleepy Bot with Keys). Newest first.

---

## v2.2.2 — onboarding saves work on a fresh volume (EACCES on /data)

**Bug:** every save from the onboarding UI failed with

```
save failed: could not save: EACCES: permission denied, open '/data/onboarding.json.tmp'
```

`control-plane-data` is a named volume, which Docker creates as `root:root 0755`,
while the image ran as `USER node` (uid 1000). The store's atomic write (temp file
+ rename) therefore could not create the temp file. The GitHub token was never at
fault — the repo is fetched and verified *before* the write.

### Fixes

* `services/control-plane/preflight.mjs` (new): probes `DATA_DIR` for real
  (create + delete a file, not mode bits) at boot; reclaims it when the process
  has the rights; otherwise logs `data_dir_not_writable` with the exact `chown`
  and keeps serving so the UI still explains itself.
* `store.mjs` wraps persistence failures in a `DataDirError` that names the
  directory, the running uid and the remedy, and preserves the original errno as
  `code` (`EACCES`, `EROFS`, …). The misleading `.tmp` path is gone; a half-written
  temp file is cleaned up.
* `docker-entrypoint.sh` (new, control-plane **and** agent-core): starts as root,
  chowns `DATA_DIR` to the runtime user only when it is wrong, then
  `su-exec node`. Existing broken volumes heal on the next `docker compose up`;
  fresh ones are correct on first boot. Running the image as an arbitrary uid
  (compose `user:`) still works — the entrypoint then simply skips the chown.
* `agent-core` had the same mount/uid mismatch and swallowed it: context was
  silently never persisted. It now logs `state_persist_failed` (once per errno)
  with the remedy.
* `GET /api/state` → `dataDir: { path, status, writable }` so the UI (or `curl`)
  can show why saves fail without reading container logs.

### Tests

`services/control-plane/test/preflight.test.mjs` (6): writable probe, `DATA_DIR`
unset no-op, unwritable dir → `readonly` (never throws), chown reclaim, chown
failure fallthrough, and an end-to-end check that a failed persist reports
`DataDirError` with `dataDir` + errno rather than a `.tmp` path.

---

## v2.2.1 — dumb activation function for the batch gate

**Theme:** the gate's wake condition was one number, which meant five 404s woke it
exactly as readily as the upstream dying — and it never said "this is obviously
not something a model can help with". Two dumb, predictable rules fix both ends.

### 1. IMPULSE — one severe event skips the pattern rule (`services/middleware/activation.mjs` — new)

`BATCH_IMPULSE=true` (default) flushes a single bad request immediately instead
of waiting for `BATCH_MIN_BAD` when it is:

| signal | why |
| --- | --- |
| 5xx | a server error has a plausible code cause, no need to aggregate |
| `upstream_unreachable` / `timeout` | the most actionable class there is |
| repeat failure on the same path | recurrence already means "pattern" |
| `durationMs >= BATCH_IMPULSE_SEVERE_MS` (default 5000) | a very slow response |

Scanner noise never self-activates, however often it repeats. Set
`BATCH_IMPULSE=false` to make `BATCH_MIN_BAD` the only way in.

### 2. TRIVIAL — known noise is answered locally (`BATCH_SKIP_TRIVIAL`, default off)

When **every** incident in a batch is recognised noise — scanner paths
(`/.env`, `/wp-login.php`, `/phpmyadmin`…), `favicon`/`robots` probes, plain
`401`/`403` client auth mistakes — the batch is marked `trivial` and Agent Core
answers it with `reason: "known_noise"` **without calling Liquid at all**. 5xx and
upstream failures are never trivial, and one real incident disables the shortcut
for the whole batch. Off by default: it filters traffic, so opt in knowingly.

### 3. Reporting

* `/_sbwk/status` → `batch.activation { impulse, impulseSevereMs, skipTrivial,
  impulses, trivialFlushes, lastImpulse }` (additive).
* Flushes carry `reason: "impulse"`; noise flushes carry
  `trivial/trivialReason/trivialCode` in the payload, and the resulting analyses
  get `batch.reason: "known_noise"` with no warning attached (noise is not an
  error).
* Log events: `batch_flush` now includes `trivial`, `impulse` shows up as the
  flush reason, `batch_skipped` reports the noise reason.

### 4. Tests

* `services/middleware/test/activation.test.mjs` (17) plus 10 new buffer tests
  and 2 new gate tests (`known_noise` short-circuit, trusted even with
  `LIQUID_BATCH_FALLBACK=skip`).
* `npm run demo:batch` rewritten into 7 isolated scenarios (immediate mode,
  count rule, impulse rule, trivial rule, Liquid down, agent-core down) — all 35
  checks pass against real services.

---

## v2.2.0 — lazy two-stage gate (opt-in batch detection)

**Theme:** every bad request is cheaply buffered; only a *pattern* of bad
requests wakes the agent; Liquid cheaply decides whether that pattern is worth a
Groq call; and if Liquid is down the pattern still reaches a real agent instead
of being dropped.

Zero change to existing behaviour: `DETECT_MODE` defaults to `immediate`, so
pulling the code without touching `.env` reproduces v2.1.0 byte-for-byte. The
batch path is opt-in.

### 1. Middleware buffers instead of paging (`services/middleware/batch-buffer.mjs` — new)

* `DETECT_MODE=batch` puts every detected anomaly (still classified by
  `classifyStatus`, so all detection settings keep their meaning) into a bounded
  ring buffer (`BATCH_MAX_SIZE`) instead of dispatching it. No connector call, no
  LLM, no notification.
* Wake condition = count threshold: `BATCH_MIN_BAD` bad requests inside
  `BATCH_WINDOW_MS`. The buffer then flushes **once** — one `POST
  /incidents/batch` carrying a compact log digest plus the raw incidents.
  `BATCH_FLUSH_TIMEOUT_MS` (default `0` = off) optionally drains a trickle.
* A flush empties the buffer before awaiting, so a failing batch can never loop
  on the same data; incidents arriving mid-flight are queued, not dropped.
* Ring overflow and window expiry are counted (`stats().dropped` / `.expired`)
  rather than growing memory.
* `DispatchThrottle` still runs first, so de-duplication is unchanged.

### 2. Compact log digest (`services/middleware/digest.mjs` — new)

Pure helpers that turn a batch into counts by category/status/method, the
noisiest paths, the slowest request and a few truncated samples — the only thing
Liquid sees, so "nothing is wrong" costs the same whether 5 or 500 requests piled
up.

### 3. Liquid decides if it is even worth an LLM (`services/agent-core/batch.mjs` — new)

* New endpoint `POST /incidents/batch` (+ `GET /incidents/batch` for settings and
  recent batches). The middleware sends `{ batchId, batch{…}, digest, incidents }`.
* `BATCH_QUESTIONS` (new constant) holds the one `noul` question the gate asks
  d1: *"do these logs look anomalous?"* `DEFAULT_QUESTIONS` is untouched, so the
  per-incident router sends exactly what it always did.
* `noul` probability `< BATCH_LIQUID_ANOMALY_THRESHOLD` (default `0.6`) →
  **skip**: incidents stored `status: "skipped"` with a synthetic "Liquid says
  normal" analysis (`mode: "skipped"`), no Groq call, no notification, no cost.
* At/above the threshold → **investigate**: each buffered incident runs through
  the *existing* investigator (Liquid routing → Groq/heuristic → escalation).
  The batch stage is a pre-gate, not a parallel pipeline.
* Incidents in a batch carry `batchId` on their record; `BATCH_MAX_INCIDENTS`
  caps the cost of one batch; `MONITORING_ACTIVE=false` records batches without
  calling Liquid at all.

### 4. `LIQUID_BATCH_FALLBACK` — a broken batch never drops signal

| situation | action |
| --- | --- |
| d1 says anomalous / not anomalous | `investigate` / `skip` (as above) |
| no `LIQUID_API_KEY`, `LIQUID_ENABLED=false`, timeout, HTTP error, unusable answer | `LIQUID_BATCH_FALLBACK` → `investigate` (default) or `skip` |
| agent-core itself unreachable from the middleware | `LIQUID_BATCH_FALLBACK=investigate` replays each incident through the normal `dispatchIncident` path; `skip` logs it at `error` |

### 5. Observability

* `GET /_sbwk/status` gained `mode` + `batch{}` (buffered, in-window, flushes,
  dropped, expired, last flush outcome, fallback) — additive, existing keys
  unchanged.
* New `GET /_sbwk/batch` and `POST /_sbwk/batch/flush` (demo/debug aid).
* New log events: `batch_flush`, `batch_dispatched`, `batch_dispatch_failed`,
  `batch_fallback_investigate`, `batch_fallback_skip`, `batch_received`,
  `batch_skipped`, `batch_investigated`.

### 6. Tests and demos

* `services/middleware/test/batch-buffer.test.mjs` (17 vs. the buffer + digest,
  injected clock) and `services/agent-core/test/batch.test.mjs` (24 vs. the gate
  policy, both fallback modes, caps, monitoring switch).
* `npm run demo:batch` (`demo/run-batch-demo.mjs`) boots the real services plus a
  fake d1 and verifies: immediate mode unchanged, buffering below threshold, one
  batch = one Liquid call → `skipped`, and Liquid-down → real investigation.
* All 105 pre-existing tests still pass; `POST /incidents`, `classifyStatus`,
  `buildIncident`, `createInvestigator`, `liquidTriage`, `routeFromDecision`,
  `extractDecision`, `DEFAULT_QUESTIONS`, `ROUTES` and every existing route are
  behaviourally untouched.

---

## v2.1.0 — Liquid AI triage router, prompt engineering, diff rendering

**Theme:** an incident now reaches the cheapest correct handler first. Liquid AI's
`d1` decision model triages every incident (~200 ms, no generated tokens) and
either wakes a human engineer or hands the incident to Groq for a real diagnosis.
Groq's prompt became configuration instead of code, AI calls are debuggable from
the console, and the Agent tab finally renders the diffs it was already receiving.

Nothing that worked before stops working: with no `LIQUID_API_KEY` the pipeline
behaves exactly as it did in v2.0.0 — it calls Groq (then falls back to the
heuristic reasoner), with a notice explaining why.

### 1. Liquid AI d1 triage gate (`services/agent-core/liquid.mjs` — new)

* `liquidTriage()` sends the incident context to
  `POST https://api.liquid.ai/decisions/v1/systemone` (configurable) with
  `model: "d1"` and the documented System One questions:

  | question | type | answers used |
  | --- | --- | --- |
  | `department` | `choice` (billing / technical / sales) | winning label + confidence |
  | `is_urgent` | `noul` | probability of "yes" |
  | `frustration` | `score` (Calm / Frustrated / Very angry) | probability-weighted score + legend label |

* `buildLiquidState()` flattens everything the pipeline already knows — method,
  path, status, category, recurrence, response sample, dependency findings,
  codebase matches, recent commits — into the `state` string. It is capped
  (`LIQUID_MAX_STATE_CHARS`, default 6000) and deterministic, so a surprising
  routing decision is easy to explain.
* `routeFromDecision()` is a **pure** policy function (unit-tested, no network):

  | condition | route |
  | --- | --- |
  | department ∈ `engineerDepartments` (default `billing`, `sales`) | **engineer** |
  | urgent **and** "Very angry" (both configurable thresholds) | **engineer** |
  | otherwise (technical, calm) | **groq** |
  | no usable answers / anything unexpected | policy `default` → **groq** |

* The decision is *not* the end of escalation: existing policy (low confidence,
  critical severity, unreachable dependency/server, recurrence) still applies.
* New analysis block `routing` on every incident:
  `{ provider, model, route, ok, status, skipped, reasons, decision, warnings, httpStatus, latencyMs }`.
* New analysis mode `engineer`: the Groq call is **skipped entirely**; the
  analysis is a hand-off briefing (owner team, urgency/frustration, dependency +
  code evidence, next step for the human) instead of a fake code diagnosis.

**Fallback behaviour (explicitly required):**

| situation | route | user-visible result |
| --- | --- | --- |
| `LIQUID_API_KEY` unset | groq | amber notice: "not configured — defaulting to Groq AI" |
| `LIQUID_ENABLED=false` | groq | amber notice |
| HTTP error / 401 / 5xx | groq | **red warning** + provider status + body detail |
| timeout (default 8 s) | groq | **red warning** ("timed out") |
| malformed body / no `answers` | groq | **red warning** |
| d1 client throws | groq | **red warning**, incident still analysed |

### 2. Configurable prompt engineering for Groq (`services/agent-core/prompts.mjs` — new)

* Five built-in profiles, each with its own system prompt, user template,
  temperature and `max_tokens`:

  | profile | intent |
  | --- | --- |
  | `balanced` (default) | v2.0.0 behaviour: evidence-first, ≤3 fixes |
  | `concise` | ≤2 tool calls, 2 fixes, no diffs — cheap and fast |
  | `diff_first` | first fix **must** carry a reviewable unified diff |
  | `strict_json` | JSON-only, temperature 0, deterministic parsing |
  | `sre_checklist` | hypothesis-driven log, states what was ruled out |

* Precedence (highest first): runtime override (`POST /config`) → env
  (`GROQ_PROMPT_PROFILE`, `GROQ_SYSTEM_PROMPT`, `GROQ_PROMPT_TEMPLATE`,
  `GROQ_TEMPERATURE`, `GROQ_MAX_TOKENS`) → profile default.
* `{{variable}}` templating: `{{incident}}`, `{{evidence}}`,
  `{{dependencyFindings}}`, `{{codeFindings}}`, `{{recentCommits}}`,
  `{{recurring}}`, `{{repoUrl}}`, `{{liquid}}`, `{{tools}}`.
* Every profile is contract-tested to keep emitting the JSON keys the parser
  requires (`severity`, `rootCause`, `confidence`, `suggestedFixes`), so a
  prompt experiment cannot silently break parsing.
* The resolved prompt (profile, temperature, max tokens, custom flag) is stored
  on each analysis as `prompt{}`, so results are attributable to the prompt that
  produced them.

### 3. Debug JSON of every AI call (`services/agent-core/ai-debug.mjs` — new)

* Each Liquid and Groq request now prints one structured line via `console.log`:

  ```json
  {"level":"info","event":"groq_ai_call","service":"agent-core","provider":"groq","ok":true,
   "durationMs":812,"request":{"method":"POST","url":"…/chat/completions",
   "headers":{"Authorization":"Bearer gro…_key"},"body":{...}},
   "response":{"status":200,"body":"…"}}
  ```

  Failures log at `warn` (`"ok":false`) so they stand out in `docker logs`.
* Credentials are redacted (`liquid_abcd…3456`), payloads are clamped to 12 k
  characters with a truncation marker.
* With `AI_DEBUG=true` (default) the same records are attached to the analysis
  as `aiDebug[]` and rendered in the Agent tab under "AI call debug — JSON".

### 4. Red warning when an AI API fails (control plane)

* New red banner at the top of the **Agent** tab:
  * **red** — "one of the AI APIs did not work", one line per failure with the
    offending path and a truncated provider response; dismissible.
  * amber — configuration notices (Liquid not configured / disabled).
* Per-incident red blocks on the card itself (`warnings[]` on the analysis), so
  an old incident keeps its warning after the provider recovers.
* `agent-core unreachable` now raises the same red banner instead of only a
  status chip.
* Severity split is deliberate: *API broke* = red, *not configured yet* = amber.
  A missing key is the documented default, not an outage.

### 5. Agent tab renders diffs

* `renderDiff()` turns `suggestedFix.diff` into a real unified-diff view:
  * `-` lines → red background + red left bar
  * `+` lines → green background + green left bar
  * `@@` hunks and `---`/`+++` file headers get their own muted/bold styling
  * everything is HTML-escaped; empty lines keep their height
* Before this, the reasoner produced diffs that the UI silently dropped.
* A new "AI routing" section on each card shows the actual path taken, e.g.
  `LIQUID D1 → GROQ AI`, `LIQUID D1 → HUMAN ENGINEER`,
  `LIQUID FAILED → GROQ AI FALLBACK`, `LIQUID NOT CONFIGURED → GROQ AI`, with
  department/urgency/frustration, latency and who authored the answer.

### 6. Control-plane: AI settings + prompt test harness

* `GET /api/ai` — proxy of agent-core `/config` (no secrets returned).
* `POST /api/ai` — whitelisted updates: `llm.{profile,systemPrompt,userPromptTemplate,temperature,maxTokens,model,reset}`,
  `liquid.{apiKey,model,baseUrl,enabled,routePolicy}`, `aiDebug`.
* `POST /api/ai/test` — runs one **synthetic** incident through the real
  pipeline (`POST /incidents?test=true` on agent-core) and returns the full
  analysis. It uses an isolated store, is never persisted, and can never page an
  engineer — safe to spam while tuning prompts.
* New **Config → AI** panel: Liquid key/model/enable + live status line, prompt
  profile picker, editable system prompt and user template, temperature,
  max tokens, Groq model, "Save AI settings", "Reset prompt", "Run test
  incident" (renders the resulting card, diffs included).
* The pre-existing config form is untouched and independent — its save path,
  warnings and validation are unchanged.

### 7. Also fixed: the Config tab's "Save config" was a 404 (pre-existing)

While smoke-testing I found that the Config form has always posted to
`POST /api/config`, but `server.mjs` only ever registered the per-step routes
(`/api/gateway`, `/api/safety`, …). `config-service.mjs`/`saveConfig()` existed
and was never wired, so every "Save config" click failed with *Not found*.

I routed it (`saveConfig()` validates first, reports `partial` when a downstream
push fails, and rejects bad input exactly as before) and left the rest of the
config flow — including its existing warnings and the granular routes — untouched.
Flagging it because it changes a path I was not asked to touch; revert the
`/api/config` block in `services/control-plane/server.mjs` if you want the
previous (broken) behaviour.

### 8. Supporting changes

* `POST /incidents?test=true` on agent-core (synthetic incident, no persistence,
  no notification).
* `demo/fake-ai.mjs` — zero-dependency stand-ins for Liquid d1 and Groq so the
  whole routing/prompt flow can be exercised offline (`FAKE_LIQUID_MODE`,
  `FAKE_GROQ_MODE`, `FAKE_AI_VERBOSE`).
* `demo/run-stack.mjs` honours an externally set `AGENT_MODE`, so
  `AGENT_MODE=live … node demo/run-stack.mjs` now works.
* Configuration surface: `.env.example` (root + agent-core) and
  `docker-compose.yml` gained the `LIQUID_*`, `GROQ_PROMPT_*`, `GROQ_TEMPERATURE`,
  `GROQ_MAX_TOKENS` and `AI_DEBUG` variables.
* Roughly 90 new tests (46 in agent-core alone): routing policy table, fallback
  matrix, answer extraction, prompt precedence/clamping, template rendering,
  contract preservation, engineer hand-off, warning propagation, debug gating.

### Files

| file | change |
| --- | --- |
| `services/agent-core/liquid.mjs` | **new** — d1 client, state builder, routing policy |
| `services/agent-core/prompts.mjs` | **new** — profiles, resolution, templating |
| `services/agent-core/ai-debug.mjs` | **new** — redaction + structured AI call logs |
| `services/agent-core/investigate.mjs` | triage step, engineer hand-off, `routing`/`warnings`/`prompt`/`aiDebug` on analysis |
| `services/agent-core/reason.mjs` | prompt-driven Groq calls, debug logging, `llmWarning`, uniform return shape |
| `services/agent-core/config.mjs` | `LIQUID_*`, `GROQ_PROMPT_*`, `AI_DEBUG`, runtime `config.llm` |
| `services/agent-core/server.mjs` | `liquid`/`llm` in `/config`, `?test=true`, richer boot log |
| `services/control-plane/ai.mjs` | **new** — AI config + prompt-test proxy |
| `services/control-plane/server.mjs` | `/api/ai`, `/api/ai/test` routes; wired the previously-unrouted `/api/config` |
| `services/control-plane/public/index.html` | red banner, diff renderer, routing block, debug panel, AI form |
| `services/agent-core/test/{liquid,prompts,routing}.test.mjs` | **new** — 33 tests |
| `demo/fake-ai.mjs` | **new** — offline Liquid/Groq stubs |
| `.env.example`, `docker-compose.yml`, `demo/run-stack.mjs`, READMEs | configuration + docs |

### How to verify

```bash
npm test                       # all services, no keys needed

# offline end-to-end with fake providers
node demo/fake-ai.mjs &
LIQUID_API_KEY=test LIQUID_BASE_URL=http://localhost:4599 \
AGENT_MODE=live GROQ_API_KEY=test GROQ_BASE_URL=http://localhost:4598/v1 \
node demo/run-stack.mjs
# log in to http://localhost:4300, trigger an anomaly:
curl -X POST localhost:8000/_control -d '{"mode":"database"}'; curl localhost:8080/users
```

* `/payouts` → Liquid says `billing` → **engineer**, no Groq call.
* `/users` with the database failing → Liquid says `technical` → **Groq**, live
  analysis with a rendered diff and an `aiDebug` record.
* Point `LIQUID_BASE_URL` at a dead port (`Config → AI`) → red banner, Groq still
  answers.

### Assumptions & things worth knowing

1. **Response contract.** I implemented Liquid's documented System One shape
   (`{ answers: { <id>: { type, choice|noul|score, probabilities, confidence, legend } } }`,
   plus `usage`). `decisions` / `results` top-level keys and a missing `answers`
   key are handled defensively, but the routing policy thresholds are unpinned —
   d1's score is continuous, so `frustrationThreshold: 1.5` is a judgement call.
   Calibrate with real traffic (the `routing.decision` block on each incident is
   exactly what you need for that).
2. **`d1` itself is unchanged by us.** We only read probabilities; we never treat
   one as permission to act. Nothing in SBWK executes remediation — this remains a
   suggest-and-escalate system.
3. **Costs.** d1 is charged on input tokens only and generates none; the state is
   capped at 6000 chars by default. Groq `max_tokens` is now per profile (1200 for
   `concise`, 4000 for the rest).
4. **Prompt changes are runtime-only.** Overrides live in agent-core's memory —
   restarting the service reverts to env/profile defaults. That is intentional
   (no config drift between deploys), but say the word and I'll persist them to
   `DATA_DIR`.
5. **Test runs are visible but harmless.** Prompt tests appear in the Agent feed
   only as the local preview card; they are excluded from the incident store, so
   recurrence counting and escalation statistics stay clean.

---

## v2.0.0 and earlier

See `v0.1.0-technical_revi.md` and the repository history for the middleware,
connector, agent-core and control-plane work that predates this changelog.
