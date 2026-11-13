import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROMPT_PROFILES, OUTPUT_CONTRACT, DEFAULT_PROFILE,
  resolvePromptSettings, renderTemplate, listProfiles
} from "../prompts.mjs";
import { buildPromptVariables } from "../reason.mjs";

const input = {
  incident: {
    id: "i", requestId: "r", method: "GET", path: "/users", statusCode: 500,
    durationMs: 12, category: "server_error", reason: "HTTP 500",
    responseSample: "{\"error\":\"pool exhausted\"}", error: "Error: pool exhausted"
  },
  dependency: {
    results: [
      { service: "database", check: "health", status: "unhealthy", data: { status: "unhealthy", checks: { connection_pool: "unhealthy" } } }
    ]
  },
  codeFindings: [{ file: "server.mjs", line: 18, snippet: "throw new Error('pool exhausted')", reason: "pool" }],
  recurring: 1,
  recentCommits: [{ sha: "abcdef1234", message: "fix payouts\nbody" }],
  repoUrl: "https://github.com/acme/app",
  liquid: { route: "groq", decision: { department: "technical" }, reasons: ["technical diagnosis is appropriate"], evidence: "department=technical" }
};

test("defaults to the balanced profile and flags itself as not custom", () => {
  const s = resolvePromptSettings({});
  assert.equal(s.profile, DEFAULT_PROFILE);
  assert.equal(s.isCustom, false);
  assert.equal(s.temperature, 0.2);
  assert.ok(s.systemPrompt.length > 100);
});

test("switching profile changes both prompt and sampling defaults", () => {
  const a = resolvePromptSettings({ GROQ_PROMPT_PROFILE: "concise" });
  const b = resolvePromptSettings({ GROQ_PROMPT_PROFILE: "diff_first" });
  assert.equal(a.profile, "concise");
  assert.equal(a.temperature, 0.1);
  assert.notEqual(a.systemPrompt, b.systemPrompt);
  assert.match(b.systemPrompt, /MUST include a short unified diff/);
});

test("an unknown profile id falls back to the default instead of throwing", () => {
  const s = resolvePromptSettings({ GROQ_PROMPT_PROFILE: "does-not-exist" });
  assert.equal(s.profile, DEFAULT_PROFILE);
});

test("runtime overrides beat env, and env beats the profile", () => {
  const env = resolvePromptSettings({ GROQ_PROMPT_PROFILE: "balanced", GROQ_TEMPERATURE: 0.9 });
  assert.equal(env.temperature, 0.9);

  const runtime = resolvePromptSettings({
    GROQ_PROMPT_PROFILE: "balanced",
    GROQ_TEMPERATURE: 0.9,
    llm: { profile: "concise", systemPrompt: "CUSTOM SYSTEM", temperature: 0.05, maxTokens: 900 }
  });
  assert.equal(runtime.profile, "concise");
  assert.equal(runtime.systemPrompt, "CUSTOM SYSTEM");
  assert.equal(runtime.temperature, 0.05);
  assert.equal(runtime.maxTokens, 900);
  assert.equal(runtime.isCustom, true);
});

test("out-of-range sampling values are clamped, not trusted", () => {
  const s = resolvePromptSettings({ llm: { temperature: 9, maxTokens: 1e9 } });
  assert.equal(s.temperature, 2);
  assert.equal(s.maxTokens, 16000);
});

test("renderTemplate substitutes variables and drops unknown ones", () => {
  const out = renderTemplate("A={{a}} B={{missing}} C={{ obj }}", { a: "x", obj: { k: 1 } });
  assert.match(out, /A=x/);
  assert.match(out, /B= /);
  assert.match(out, /"k": 1/);
});

test("every profile keeps the JSON output contract the parser depends on", () => {
  const clause = "confidence and rootCause.confidence MUST be JSON numbers between 0 and 1, not strings.";
  assert.ok(OUTPUT_CONTRACT.includes(clause));
  for (const [id, p] of Object.entries(PROMPT_PROFILES)) {
    assert.ok(p.systemPrompt.includes("severity"), `${id} must specify severity`);
    assert.ok(p.systemPrompt.includes("suggestedFixes"), `${id} must specify suggestedFixes`);
    assert.ok(p.systemPrompt.includes("rootCause"), `${id} must specify rootCause`);
  }
});

test("every profile template renders with the real variable set", () => {
  const vars = buildPromptVariables(input);
  for (const [id, p] of Object.entries(PROMPT_PROFILES)) {
    const out = renderTemplate(p.userPromptTemplate, vars);
    assert.ok(out.length > 40, `${id} rendered too short`);
    assert.ok(!/\{\{/.test(out), `${id} left an unrendered placeholder: ${out.match(/\{\{[^}]*\}\}/)}`);
    assert.match(out, /\/users/, `${id} should contain the incident path`);
  }
});

test("prompt variables expose the Liquid decision when it exists", () => {
  const vars = buildPromptVariables(input);
  assert.match(vars.liquid, /technical/);
  const none = buildPromptVariables({ ...input, liquid: undefined });
  assert.match(none.liquid, /not consulted/);
});

test("listProfiles exposes only displayable metadata", () => {
  const list = listProfiles();
  assert.ok(list.length >= 5);
  for (const p of list) {
    assert.ok(p.id && p.label && p.description);
    assert.equal(p.systemPrompt, undefined);
  }
});
