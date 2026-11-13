import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyImpulse, explainTrivial, explainBatch, TRIVIAL_REASONS } from "../activation.mjs";

const inc = (o = {}) => ({
  id: "i", method: "GET", path: "/users", statusCode: 500, durationMs: 10,
  category: "server_error", reason: "HTTP 500", ...o
});

/* ── IMPULSE: one severe event may skip the pattern rule ─────────────────── */

test("a 5xx is an impulse on its own", () => {
  const v = classifyImpulse(inc({ statusCode: 500, category: "server_error" }));
  assert.equal(v.impulse, true);
  assert.match(v.reasons.join(" "), /server error HTTP 500/);
});

test("an unreachable or timed-out upstream is the strongest impulse", () => {
  const unreachable = classifyImpulse(inc({ statusCode: 502, category: "upstream_unreachable" }));
  const timeout = classifyImpulse(inc({ statusCode: 504, category: "timeout" }));
  assert.equal(unreachable.impulse, true);
  assert.equal(timeout.impulse, true);
  assert.match(timeout.reasons.join(" "), /timed out/);
  assert.ok(unreachable.score > classifyImpulse(inc({ statusCode: 500 })).score);
});

test("a plain 404 on a real route is NOT an impulse", () => {
  const v = classifyImpulse(inc({ statusCode: 404, category: "client_error", path: "/checkout" }));
  assert.equal(v.impulse, false);
  assert.deepEqual(v.reasons, []);
});

test("a very slow response is an impulse when it crosses the threshold", () => {
  const slow = classifyImpulse(inc({ statusCode: 200, category: "server_error", durationMs: 6000 }), { severeMs: 5000 });
  const ok = classifyImpulse(inc({ statusCode: 200, durationMs: 300 }), { severeMs: 5000 });
  assert.equal(slow.impulse, true);
  assert.match(slow.reasons.join(" "), /6000ms/);
  assert.equal(ok.impulse, false);
});

test("a repeat failure on the same path is an impulse", () => {
  const v = classifyImpulse(inc({ statusCode: 404, category: "client_error", path: "/search" }), { recurrence: 1 });
  assert.equal(v.impulse, true);
  assert.match(v.reasons.join(" "), /repeated failure on \/search \(2x recently\)/);
});

test("BATCH_IMPULSE=false (severeStatuses off) defuses status/duration impulses", () => {
  const v = classifyImpulse(inc({ statusCode: 500 }), { severeStatuses: false });
  assert.equal(v.impulse, false);
});

test("scanner noise never self-activates, however often it repeats", () => {
  const v = classifyImpulse(inc({ path: "/.env", statusCode: 404, category: "client_error" }), { recurrence: 9 });
  assert.equal(v.impulse, false);
  assert.equal(v.suppressedByTrivial, true);
  assert.match(v.reasons.join(" "), /scanner/);
});

test("but an upstream outage on any path still self-activates", () => {
  const v = classifyImpulse(inc({ path: "/.env", statusCode: 502, category: "upstream_unreachable" }));
  assert.equal(v.impulse, true);
});

/* ── TRIVIAL: what no LLM (or human) can act on ──────────────────────────── */

test("scanner paths and asset probes are trivial", () => {
  assert.equal(explainTrivial(inc({ path: "/.env", statusCode: 404 })).code, "scanner_path");
  assert.equal(explainTrivial(inc({ path: "/wp-login.php", statusCode: 404 })).code, "scanner_path");
  assert.equal(explainTrivial(inc({ path: "/favicon.ico", statusCode: 404 })).code, "bot_or_asset");
  assert.equal(explainTrivial(inc({ path: "/robots.txt", statusCode: 404 })).code, "bot_or_asset");
});

test("plain client auth mistakes and unknown routes are trivial", () => {
  assert.equal(explainTrivial(inc({ statusCode: 401, category: "client_error" })).code, "client_auth");
  assert.equal(explainTrivial(inc({ statusCode: 403, category: "client_error" })).code, "client_auth");
  assert.equal(explainTrivial(inc({ statusCode: 404, category: "client_error", path: "/checkout" })).code, "not_found");
});

test("server errors and upstream failures are never trivial", () => {
  assert.equal(explainTrivial(inc({ statusCode: 500 })).trivial, false);
  assert.equal(explainTrivial(inc({ statusCode: 502, category: "upstream_unreachable" })).trivial, false);
  assert.equal(explainTrivial(inc({ statusCode: 504, category: "timeout" })).trivial, false);
});

test("client errors can be made non-trivial (ignoreClientErrors=false)", () => {
  assert.equal(explainTrivial(inc({ statusCode: 404 }), { ignoreClientErrors: false }).trivial, false);
});

test("TRIVIAL_REASONS is human readable for the UI/log", () => {
  for (const [code, text] of Object.entries(TRIVIAL_REASONS)) {
    assert.equal(typeof code, "string");
    assert.ok(text.length > 10, `${code} should explain itself`);
  }
});

/* ── TRIVIAL over a whole batch ──────────────────────────────────────────── */

test("a batch of pure noise is trivial, with the dominant code", () => {
  const verdict = explainBatch([
    inc({ path: "/.env", statusCode: 404, category: "client_error" }),
    inc({ path: "/wp-login.php", statusCode: 404, category: "client_error" }),
    inc({ path: "/", statusCode: 401, category: "client_error" })
  ]);
  assert.equal(verdict.trivial, true);
  assert.equal(verdict.real, 0);
  assert.equal(verdict.trivialCount, 3);
  assert.ok(verdict.code);
});

test("ONE real incident makes the whole batch worth a model call", () => {
  const verdict = explainBatch([
    inc({ path: "/.env", statusCode: 404, category: "client_error" }),
    inc({ path: "/checkout", statusCode: 500 })
  ]);
  assert.equal(verdict.trivial, false);
  assert.equal(verdict.real, 1);
  assert.equal(verdict.trivialCount, 1);
});

test("an empty batch is not 'trivial' (nothing to judge)", () => {
  const verdict = explainBatch([]);
  assert.equal(verdict.trivial, false);
  assert.equal(verdict.real, 0);
});
