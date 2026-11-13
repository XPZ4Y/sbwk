# Control plane: integration notes

These files replace the matching files in `services/control-plane/`. `config.mjs`, `auth.mjs`,
`server.mjs` and `public/index.html` are not included in full; the changes are below.

## 1. config.mjs: one new line

    BLOCK_PRIVATE_NETWORKS: str(env.BLOCK_PRIVATE_NETWORKS, "false") === "true",

Leave it `false` in development. The compose demo targets `http://server:8000`, which is a private
address, so enabling it breaks the demo. Turn it on for hosted deployments with public targets.

## 2. server.mjs: routes

Add the imports, and remove the ones no longer used (`checkReachability`, `fetchGitHubRepo`, `applyGateway`,
`applyExternal`, `applyCodebase`, `applySafety`, `applyMonitoring`).

    import { saveConfig, checkServices, checkGateway } from "./config-service.mjs";

Inside the authenticated `/api` section, replace the old config routes with:

    if (p === "/api/config" && req.method === "POST") {
      let body;
      try { body = await readJson(req, 256 * 1024); }
      catch (e) { return fail(res, 400, e.message); }
      const r = await saveConfig(body);
      return sendJson(res, r.status, r.body);
    }
    if (p === "/api/config/check" && req.method === "POST") return sendJson(res, 200, await checkServices());
    if (p === "/api/gateway/check" && req.method === "POST") return sendJson(res, 200, await checkGateway());
    if (p.startsWith("/api/external")) return fail(res, 410, "Gone: use POST /api/config");

Delete the old `/api/gateway` POST, `/api/codebase`, `/api/safety`, `/api/monitoring/start|stop` and
`/api/external/test` routes. They skip validation and are not used by the new console.

`/api/logs` and `/api/incidents` must report failure explicitly, so the console can show it:

    try {
      const r = await fetch(`${config.MIDDLEWARE_URL}/_sbwk/logs?limit=${limit}`, { ... });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      return ok(res, { logs: data.logs || [] });
    } catch {
      return ok(res, { logs: [], unreachable: true });
    }

Use the same pattern for `/api/incidents`, with `incidents: []` and `unreachable: true`.

Keep the session check in front of all `/api` routes. `/api/state` must stay redacted.

## 3. public/index.html

- Replace the inline `<script>` with `<script src="/app.js" defer></script>`.
- Remove the two Google Fonts `<link>` tags. Self-host JetBrains Mono under `/fonts/` if you want it.
- Requests tab: change the "total" label to "in window". The count is the last 100 rows.
- Add `<div class="hint" id="hint-repo"></div>` under the repo URL field.
- Add `<div class="hint" id="gateway-check"></div>` under the target URL field.
- In `.form-actions` add:
    <button type="button" class="btn-ghost" id="btn-gateway-check">Test gateway</button>
    <button type="button" class="btn-ghost" id="btn-check">Test connections</button>
- CSS addendum:
    .field .hint.ok { color: var(--ok); }
    .warn-line.error .warn-key { color: var(--bad); }
- About tab: change the rollback sentence to "Auto-rollback is stored as a setting. This release does not
  yet revert changes." Keep the gateway and database claims in line with what the code does.

## 4. Assumptions to verify before shipping

- agent-connector's `POST /connector/config` treats the body as a full replace. The console always pushes
  the complete map, so removing a service only clears it at the connector if the connector does the same.
- `checkGateway` sends a real request through the edge to the target's `/`. Pick a path that is safe to hit.
- `onboarding.json` from the previous version is migrated on load. A corrupt file is moved aside
  (`*.corrupt-<time>`), not overwritten. Files written by the old default have `monitoring.active: true`
  only if someone started monitoring, but check once.

## 5. What was verified here

- `node --check` passes on every changed `.mjs` file and on `public/app.js`.
- 34 unit tests pass (`node --test test/*.test.mjs`). They cover the token rules, the repo rules, atomic
  saves, partial pushes, validate-only, the SSRF guard, the checks and the gateway check.
- Not verified: the browser UI, `server.mjs` routing, and a live stack. The route snippet above has not
  been executed against a running control plane.
