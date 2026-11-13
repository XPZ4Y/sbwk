import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.mjs";
import { sendResendEmail, notifyEngineer } from "../notify.mjs";

const sampleIncident = {
  id: "inc-resend-1",
  method: "POST",
  path: "/checkout",
  statusCode: 500
};

const sampleAnalysis = {
  severity: "high",
  summary: "Database connection pool exhausted",
  rootCause: { summary: "Timeout acquiring connection from pool" },
  suggestedFixes: ["Increase pool max size", "Check for unclosed connections"],
  rollbackDecision: {
    shouldRollback: true,
    targetCommitSha: "abc1234",
    reason: "Recent commit introduced unclosed DB connection"
  }
};

test("sendResendEmail skips when RESEND_API_KEY or DEVELOPER_EMAIL is unset", async () => {
  const prevKey = config.RESEND_API_KEY;
  const prevEmail = config.DEVELOPER_EMAIL;
  config.RESEND_API_KEY = undefined;
  config.DEVELOPER_EMAIL = undefined;

  try {
    const res = await sendResendEmail(sampleIncident, sampleAnalysis, "test");
    assert.equal(res.attempted, false);
    assert.equal(res.sent, false);
  } finally {
    config.RESEND_API_KEY = prevKey;
    config.DEVELOPER_EMAIL = prevEmail;
  }
});

test("sendResendEmail posts to Resend API with zero dependencies", async () => {
  const prevKey = config.RESEND_API_KEY;
  const prevEmail = config.DEVELOPER_EMAIL;
  const prevFrom = config.RESEND_FROM_EMAIL;
  config.RESEND_API_KEY = "re_test_123456";
  config.DEVELOPER_EMAIL = "dev@example.com";
  config.RESEND_FROM_EMAIL = "alerts@example.com";

  let capturedUrl = null;
  let capturedInit = null;
  const mockFetch = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "email_123" })
    };
  };

  try {
    const res = await sendResendEmail(sampleIncident, sampleAnalysis, "500 spike", mockFetch);
    assert.equal(res.attempted, true);
    assert.equal(res.sent, true);
    assert.equal(res.id, "email_123");
    assert.equal(capturedUrl, "https://api.resend.com/emails");
    assert.equal(capturedInit.method, "POST");
    assert.equal(capturedInit.headers.Authorization, "Bearer re_test_123456");

    const body = JSON.parse(capturedInit.body);
    assert.equal(body.from, "alerts@example.com");
    assert.deepEqual(body.to, ["dev@example.com"]);
    assert.match(body.subject, /\[SBWK\] HIGH Fault: POST \/checkout \(HTTP 500\)/);
    assert.match(body.text, /Rollback Recommended: YES/);
    assert.match(body.html, /Rollback Recommended:/);
  } finally {
    config.RESEND_API_KEY = prevKey;
    config.DEVELOPER_EMAIL = prevEmail;
    config.RESEND_FROM_EMAIL = prevFrom;
  }
});

test("notifyEngineer reports resend channel when configured", async () => {
  const prevKey = config.RESEND_API_KEY;
  const prevEmail = config.DEVELOPER_EMAIL;
  const prevWebhook = config.NOTIFICATION_WEBHOOK_URL;
  config.RESEND_API_KEY = "re_test_123456";
  config.DEVELOPER_EMAIL = "dev@example.com";
  config.NOTIFICATION_WEBHOOK_URL = undefined;

  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: "email_456" })
  });

  try {
    const res = await notifyEngineer(sampleIncident, sampleAnalysis, "escalation policy", mockFetch);
    assert.equal(res.sent, true);
    assert.equal(res.channel, "resend+log".replace("resend+log", "log+resend"));
  } finally {
    config.RESEND_API_KEY = prevKey;
    config.DEVELOPER_EMAIL = prevEmail;
    config.NOTIFICATION_WEBHOOK_URL = prevWebhook;
  }
});
