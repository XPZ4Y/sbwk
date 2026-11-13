import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// Start a tiny stub agent-core BEFORE importing notifications.mjs so config picks up its URL.
const seen = [];
const stub = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
  seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });

  res.writeHead(200, { "Content-Type": "application/json" });
  if (req.url === "/notifications/status") {
    return res.end(JSON.stringify({ success: true, notifications: { state: "ready", hasApiKey: true, recipients: ["dev@example.com"] } }));
  }
  if (req.url === "/config") {
    return res.end(JSON.stringify({ success: true, config: { notifications: { state: "ready", recipients: [body.notifications.developerEmail] } } }));
  }
  if (req.url === "/notifications/verify") {
    return res.end(JSON.stringify({ success: true, verification: { ok: false, code: "invalid_api_key", error: "API key is invalid" } }));
  }
  if (req.url === "/notifications/test") {
    return res.end(JSON.stringify({ success: true, result: { sent: true, id: "email_test_99" } }));
  }
  res.writeHead(404);
  res.end();
});

await new Promise(resolve => stub.listen(0, "127.0.0.1", resolve));
const port = stub.address().port;

process.env.AGENT_CORE_URL = `http://127.0.0.1:${port}`;
process.env.AGENT_CORE_TOKEN = "cp-test-token-123456";

const {
  getNotificationStatus,
  saveNotificationConfig,
  verifyNotifications,
  sendTestNotification
} = await import("../notifications.mjs");

test("control-plane notifications bridge proxies status, whitelisted config, verify and test with bearer auth", async () => {
  try {
    const status = await getNotificationStatus();
    assert.equal(status.ok, true);
    assert.equal(status.notifications.state, "ready");
    assert.equal(seen.at(-1).auth, "Bearer cp-test-token-123456");

    // Smuggled keys must be stripped before forwarding to agent-core
    const saved = await saveNotificationConfig({
      developerEmail: "ops@example.com",
      notifyAllIncidents: false,
      apiBaseUrl: "http://evil.local",
      maliciousKey: true
    });
    assert.equal(saved.ok, true);
    assert.deepEqual(seen.at(-1).body, {
      notifications: { developerEmail: "ops@example.com", notifyAllIncidents: false }
    });

    const verified = await verifyNotifications({ resendApiKey: "re_bad" });
    assert.equal(verified.ok, true);
    assert.equal(verified.verification.code, "invalid_api_key");

    const tested = await sendTestNotification({ reason: "smoke" });
    assert.equal(tested.ok, true);
    assert.equal(tested.result.sent, true);
    assert.equal(tested.result.id, "email_test_99");

    // Empty config update is rejected cleanly without hitting agent-core
    const empty = await saveNotificationConfig({});
    assert.equal(empty.ok, false);
    assert.equal(empty.status, 400);
  } finally {
    await new Promise(resolve => stub.close(resolve));
  }
});
