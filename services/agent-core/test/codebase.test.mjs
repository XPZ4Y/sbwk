import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deriveKeywords, inspectCodebase } from "../codebase.mjs";

function incident(o = {}) {
  return { id: "i", requestId: "r", source: "middleware", detectedAt: new Date().toISOString(), method: "GET", path: "/users/profile", statusCode: 500, durationMs: 1, upstream: "http://server:80", category: "server_error", reason: "HTTP 500", ...o };
}

test("deriveKeywords extracts path segments and error terms", () => {
  const k = deriveKeywords(incident({ responseSample: "connection pool exhausted" }));
  assert.ok(k.includes("users"));
  assert.ok(k.includes("profile"));
  assert.ok(k.includes("pool"));
});

test("deriveKeywords ignores numeric id segments", () => {
  const k = deriveKeywords(incident({ path: "/users/12345/orders" }));
  assert.ok(!k.includes("12345"));
  assert.ok(k.includes("orders"));
});

test("inspectCodebase finds relevant source files read-only", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sbwk-code-"));
  await fs.writeFile(path.join(dir, "users.ts"), "export function getUsers() {\n  // database query for users\n  return db.query('select * from users');\n}\n");
  await fs.writeFile(path.join(dir, "unrelated.ts"), "export const x = 1;\n");

  const findings = await inspectCodebase(incident({ path: "/users", responseSample: "database error" }), { root: dir });
  assert.ok(findings.length > 0);
  assert.equal(findings[0].file, "users.ts");
  assert.match(findings[0].snippet, /users/);

  await fs.rm(dir, { recursive: true, force: true });
});
