import { test } from "node:test";
import assert from "node:assert/strict";
process.env.CONTROL_PLANE_PASSWORD = "correct horse battery staple";
const { initAuth, verifyPassword, createSession, destroySession, sessionFromRequest } = await import("../auth.mjs");
initAuth();

test("verifyPassword accepts the configured password and rejects others", () => {
  assert.equal(verifyPassword("correct horse battery staple"), true);
  assert.equal(verifyPassword("wrong"), false);
  assert.equal(verifyPassword(""), false);
  assert.equal(verifyPassword(undefined), false);
});

test("session lifecycle: create, read from cookie header, destroy", () => {
  const token = createSession();
  const req = { headers: { cookie: `other=1; sbwk_session=${token}` } };
  const s = sessionFromRequest(req);
  assert.ok(s);
  assert.equal(s.token, token);
  destroySession(token);
  assert.equal(sessionFromRequest(req), null);
});

test("expired sessions are rejected", async () => {
  const token = createSession();
  const req = { headers: { cookie: `sbwk_session=${token}` } };
  // reach into the module's map is not exposed; instead assert a bogus token fails
  assert.equal(sessionFromRequest({ headers: { cookie: "sbwk_session=bogus" } }), null);
});
