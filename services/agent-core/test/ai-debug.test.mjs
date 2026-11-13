import { test } from "node:test";
import assert from "node:assert/strict";
import { redactKey, redactHeaders, clamp, debugRecord, logAiCall } from "../ai-debug.mjs";

test("keys are never logged in full", () => {
  assert.equal(redactKey("liquid_abcdefghijklmnop1234"), "liq…1234");
  assert.equal(redactKey("short"), "***");
  assert.equal(redactKey(undefined), null);
});

test("authorization headers are redacted, other headers are kept", () => {
  const h = redactHeaders({ Authorization: "Bearer secret-token-value", "Content-Type": "application/json" });
  assert.match(h.Authorization, /^Bearer liq|^Bearer sec/);
  assert.ok(!h.Authorization.includes("secret-token-value"));
  assert.equal(h["Content-Type"], "application/json");
});

test("clamp truncates long payloads and announces how much was cut", () => {
  const out = clamp("x".repeat(50), 10);
  assert.match(out, /40 chars truncated/);
  assert.equal(clamp(undefined), undefined);
  assert.equal(clamp({ a: 1 }), '{"a":1}');
});

test("debugRecord records the call shape with a redacted key", () => {
  const rec = debugRecord({
    provider: "groq", ok: true, durationMs: 12,
    request: { method: "POST", url: "https://api.example/v1/chat", headers: { Authorization: "Bearer abcdefgh12345678" }, body: { model: "x" } },
    response: { status: 200, body: "{}" }
  });
  assert.equal(rec.provider, "groq");
  assert.equal(rec.request.url, "https://api.example/v1/chat");
  assert.ok(!rec.request.headers.Authorization.includes("abcdefgh12345678"));
  assert.equal(rec.request.body.model, "x");
  assert.equal(rec.response.status, 200);
  assert.equal(rec.response.body, "{}");
});

test("logAiCall writes one JSON line and downgrades failures to warn", () => {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    logAiCall("groq_ai_call", { provider: "groq", ok: true, durationMs: 5, request: { url: "u" } });
    logAiCall("liquid_ai_call", { provider: "liquid", ok: false, durationMs: 9, error: "HTTP 500" });
  } finally {
    console.log = original;
  }
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  const second = JSON.parse(lines[1]);
  assert.equal(first.level, "info");
  assert.equal(first.event, "groq_ai_call");
  assert.equal(first.service, "agent-core");
  assert.equal(second.level, "warn");
  assert.equal(second.error, "HTTP 500");
});
