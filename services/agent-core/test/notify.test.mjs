import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { config, parseEnvContent } from "../config.mjs";
import {
  EMAIL_ERROR_CODES,
  USER_AGENT,
  escapeHtml,
  sanitizeSubject,
  parseRecipients,
  validateFromAddress,
  validateApiKey,
  validateMailConfig,
  buildEmailPayload,
  sendResendEmail,
  verifyResendConfig,
  sendTestEmail,
  notifyEngineer,
  getNotificationStatus,
  resetNotificationTelemetry
} from "../notify.mjs";
import { createInvestigator } from "../investigate.mjs";
import { IncidentStore } from "../store.mjs";
import { heuristicReason } from "../reason.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentCoreDir = path.resolve(__dirname, "..");

const noSleep = async () => {};

const sampleIncident = {
  id: "inc-resend-1",
  requestId: "req-1",
  source: "middleware",
  detectedAt: "2026-11-13T20:00:00.000Z",
  method: "POST",
  path: "/checkout",
  statusCode: 500,
  durationMs: 420,
  upstream: "http://server:8000",
  category: "server_error",
  reason: "HTTP 500"
};

const sampleAnalysis = {
  severity: "high",
  confidence: 0.85,
  summary: "Database connection pool exhausted",
  rootCause: { summary: "Timeout acquiring connection from pool", confidence: 0.85 },
  dependencyFindings: [{ service: "database", status: "unhealthy", signals: ["pool 100%"] }],
  suggestedFixes: [
    "Increase pool max size",
    { title: "Close leaked connections", description: "Release connections in finally block", file: "db.mjs" }
  ],
  rollbackDecision: {
    shouldRollback: true,
    targetCommitSha: "abc1234",
    reason: "Recent commit introduced unclosed DB connection"
  }
};

function makeCfg(overrides = {}) {
  return {
    RESEND_API_KEY: "re_test_1234567890",
    DEVELOPER_EMAIL: "dev@example.com",
    RESEND_FROM_EMAIL: "alerts@example.com",
    RESEND_NOTIFY_ALL_INCIDENTS: true,
    RESEND_API_BASE_URL: "https://api.resend.com",
    RESEND_TIMEOUT_MS: 5000,
    RESEND_MAX_RETRIES: 2,
    REQUEST_TIMEOUT_MS: 5000,
    ...overrides
  };
}

function mockRes(status, bodyObjOrStr, headers = {}) {
  const isStr = typeof bodyObjOrStr === "string";
  const textVal = isStr ? bodyObjOrStr : JSON.stringify(bodyObjOrStr);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => textVal,
    json: async () => (isStr ? JSON.parse(textVal) : bodyObjOrStr)
  };
}

/* ── 1. .env parsing ────────────────────────────────────────────────────── */

test("parseEnvContent handles CRLF, quotes, export prefix, inline comments and whitespace", () => {
  const parsed = parseEnvContent([
    "# comment",
    "RESEND_API_KEY = \"re_abc_123456789\"  ",
    "export DEVELOPER_EMAIL='dev@example.com, ops@example.com'",
    "RESEND_FROM_EMAIL=SBWK Alerts <alerts@example.com> # inline comment",
    "EMPTY_VAL=",
    "TRAILING_CR=value123\r"
  ].join("\r\n"));

  assert.equal(parsed.RESEND_API_KEY, "re_abc_123456789");
  assert.equal(parsed.DEVELOPER_EMAIL, "dev@example.com, ops@example.com");
  assert.equal(parsed.RESEND_FROM_EMAIL, "SBWK Alerts <alerts@example.com>");
  assert.equal(parsed.EMPTY_VAL, "");
  assert.equal(parsed.TRAILING_CR, "value123");
});

/* ── 2. Validation helpers ──────────────────────────────────────────────── */

test("parseRecipients supports comma/semicolon lists, display names, dedupe and invalid detection", () => {
  const r = parseRecipients("Alice@Example.com, bob@example.com; alice@example.com, Ops <ops@example.com>, bad-email, @nope.com");
  assert.deepEqual(r.valid, ["Alice@Example.com", "bob@example.com", "Ops <ops@example.com>"]);
  assert.deepEqual(r.invalid, ["bad-email", "@nope.com"]);
  assert.equal(r.truncated, 0);

  const many = Array.from({ length: 55 }, (_, i) => `u${i}@example.com`).join(",");
  const capped = parseRecipients(many);
  assert.equal(capped.valid.length, 50);
  assert.equal(capped.truncated, 5);
});

test("validateFromAddress accepts bare and display-name formats and detects sandbox sender", () => {
  const sandbox = validateFromAddress("onboarding@resend.dev");
  assert.equal(sandbox.ok, true);
  assert.equal(sandbox.isSandbox, true);
  assert.equal(sandbox.domain, "resend.dev");

  const named = validateFromAddress("SBWK Alerts <alerts@acme.io>");
  assert.equal(named.ok, true);
  assert.equal(named.isSandbox, false);
  assert.equal(named.domain, "acme.io");
  assert.equal(named.value, "SBWK Alerts <alerts@acme.io>");

  assert.equal(validateFromAddress("not-an-email").ok, false);
  assert.equal(validateFromAddress("alerts@acme.io\r\nBcc: evil@x.com").ok, false);
});

test("validateApiKey rejects whitespace, control chars and literal quotes, and warns on non-re_ prefix", () => {
  assert.equal(validateApiKey(undefined).present, false);
  assert.equal(validateApiKey("re_valid_key_12345").ok, true);
  assert.equal(validateApiKey("re_valid_key_12345").formatOk, true);

  assert.equal(validateApiKey("re_has\nnewline").ok, false);
  assert.equal(validateApiKey("re_has space").ok, false);
  assert.equal(validateApiKey('"re_quoted_12345"').ok, false);

  const oddPrefix = validateApiKey("sk_wrong_prefix_12345");
  assert.equal(oddPrefix.ok, true);
  assert.equal(oddPrefix.formatOk, false);
  assert.match(oddPrefix.warning, /re_/);
});

test("validateMailConfig distinguishes not_configured, misconfigured (partial/invalid) and ready", () => {
  const none = validateMailConfig({});
  assert.equal(none.state, "not_configured");
  assert.equal(none.errors.length, 0);

  const keyOnly = validateMailConfig({ RESEND_API_KEY: "re_test_123456789" });
  assert.equal(keyOnly.state, "misconfigured");
  assert.equal(keyOnly.partiallyConfigured, true);
  assert.equal(keyOnly.errors[0].code, EMAIL_ERROR_CODES.MISSING_RECIPIENT);

  const emailOnly = validateMailConfig({ DEVELOPER_EMAIL: "dev@example.com" });
  assert.equal(emailOnly.state, "misconfigured");
  assert.equal(emailOnly.partiallyConfigured, true);
  assert.equal(emailOnly.errors[0].code, EMAIL_ERROR_CODES.MISSING_API_KEY);

  const badEmail = validateMailConfig(makeCfg({ DEVELOPER_EMAIL: "not-valid" }));
  assert.equal(badEmail.state, "misconfigured");
  assert.equal(badEmail.errors[0].code, EMAIL_ERROR_CODES.INVALID_RECIPIENT_EMAIL);

  const badBase = validateMailConfig(makeCfg({ RESEND_API_BASE_URL: "ftp://bad.host" }));
  assert.equal(badBase.state, "misconfigured");
  assert.equal(badBase.errors[0].code, EMAIL_ERROR_CODES.INVALID_BASE_URL);

  const ready = validateMailConfig(makeCfg({ RESEND_FROM_EMAIL: "onboarding@resend.dev" }));
  assert.equal(ready.state, "ready");
  assert.equal(ready.valid, true);
  assert.equal(ready.isSandboxFrom, true);
  assert.ok(ready.warnings.some(w => w.code === "sandbox_sender"));
});

/* ── 3. Payload sanitization & rendering ────────────────────────────────── */

test("sanitizeSubject and escapeHtml neutralize CRLF injection and XSS", () => {
  assert.equal(sanitizeSubject("Hello\r\nBcc: attacker@evil.com\nLine"), "Hello Bcc: attacker@evil.com Line");
  assert.ok(sanitizeSubject("x".repeat(400), 200).length <= 200);
  assert.equal(escapeHtml(`<script>alert('x' & "y")</script>`), "&lt;script&gt;alert(&#39;x&#39; &amp; &quot;y&quot;)&lt;/script&gt;");

  const payload = buildEmailPayload(
    { id: "i1", method: "GET", path: "/a\r\n<script>", statusCode: 500 },
    sampleAnalysis,
    "reason",
    { from: "alerts@example.com", to: ["dev@example.com"] }
  );
  assert.ok(!/[\r\n]/.test(payload.subject));
  assert.ok(!payload.html.includes("<script>"));
  assert.match(payload.text, /Close leaked connections \(db\.mjs\)/);
  assert.match(payload.html, /<strong>Close leaked connections<\/strong>/);
});

/* ── 4. sendResendEmail backwards compat + full error matrix ────────────── */

test("sendResendEmail skips cleanly when RESEND_API_KEY and DEVELOPER_EMAIL are unset", async () => {
  const prevKey = config.RESEND_API_KEY;
  const prevEmail = config.DEVELOPER_EMAIL;
  config.RESEND_API_KEY = undefined;
  config.DEVELOPER_EMAIL = undefined;

  try {
    const res = await sendResendEmail(sampleIncident, sampleAnalysis, "test");
    assert.equal(res.attempted, false);
    assert.equal(res.sent, false);
    assert.equal(res.code, EMAIL_ERROR_CODES.NOT_CONFIGURED);
  } finally {
    config.RESEND_API_KEY = prevKey;
    config.DEVELOPER_EMAIL = prevEmail;
  }
});

test("sendResendEmail posts to Resend API with User-Agent, Idempotency-Key and minimal mock compat", async () => {
  const prevKey = config.RESEND_API_KEY;
  const prevEmail = config.DEVELOPER_EMAIL;
  const prevFrom = config.RESEND_FROM_EMAIL;
  config.RESEND_API_KEY = "re_test_1234567890";
  config.DEVELOPER_EMAIL = "dev@example.com";
  config.RESEND_FROM_EMAIL = "alerts@example.com";

  let capturedUrl = null;
  let capturedInit = null;
  // Minimal mock matching legacy test shape (json only, no text() or headers)
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
    assert.equal(res.attempts, 1);
    assert.equal(capturedUrl, "https://api.resend.com/emails");
    assert.equal(capturedInit.method, "POST");
    assert.equal(capturedInit.headers.Authorization, "Bearer re_test_1234567890");
    assert.equal(capturedInit.headers["User-Agent"], USER_AGENT);
    assert.ok(capturedInit.headers["Idempotency-Key"].startsWith("sbwk-"));

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

test("sendResendEmail delivers to multiple comma-separated recipients", async () => {
  let body = null;
  const res = await sendResendEmail(sampleIncident, sampleAnalysis, "alert", {
    config: makeCfg({ DEVELOPER_EMAIL: "a@example.com, b@example.com, A@example.com" }),
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return mockRes(200, { id: "email_multi" });
    },
    sleep: noSleep
  });
  assert.equal(res.sent, true);
  assert.deepEqual(body.to, ["a@example.com", "b@example.com"]);
});

test("sendResendEmail fails fast without fetch on misconfiguration (missing recipient / bad key / bad email)", async () => {
  let fetchCalled = false;
  const fetchImpl = async () => { fetchCalled = true; return mockRes(200, { id: "nope" }); };

  const r1 = await sendResendEmail(sampleIncident, sampleAnalysis, "x", {
    config: makeCfg({ DEVELOPER_EMAIL: undefined }),
    fetchImpl
  });
  assert.equal(r1.sent, false);
  assert.equal(r1.attempted, false);
  assert.equal(r1.code, EMAIL_ERROR_CODES.MISSING_RECIPIENT);

  const r2 = await sendResendEmail(sampleIncident, sampleAnalysis, "x", {
    config: makeCfg({ RESEND_API_KEY: "re_bad\nkey" }),
    fetchImpl
  });
  assert.equal(r2.sent, false);
  assert.equal(r2.code, EMAIL_ERROR_CODES.INVALID_API_KEY);

  const r3 = await sendResendEmail(sampleIncident, sampleAnalysis, "x", {
    config: makeCfg({ DEVELOPER_EMAIL: "invalid-email" }),
    fetchImpl
  });
  assert.equal(r3.sent, false);
  assert.equal(r3.code, EMAIL_ERROR_CODES.INVALID_RECIPIENT_EMAIL);

  assert.equal(fetchCalled, false, "misconfigured mail must never call fetch");
});

test("sendResendEmail classifies invalid API key (401/403/400) and NEVER retries", async () => {
  for (const [status, body] of [
    [401, { statusCode: 401, name: "validation_error", message: "API key is invalid" }],
    [401, { statusCode: 401, name: "missing_api_key", message: "Missing API Key" }],
    [400, { statusCode: 400, name: "validation_error", message: "API key is invalid" }],
    [403, { statusCode: 403, name: "invalid_api_key", message: "API key is invalid" }],
    [403, { statusCode: 403, name: "restricted_api_key", message: "API key is not active" }]
  ]) {
    let calls = 0;
    const res = await sendResendEmail(sampleIncident, sampleAnalysis, "x", {
      config: makeCfg({ RESEND_API_KEY: "bad_token_value_123", RESEND_MAX_RETRIES: 3 }),
      fetchImpl: async () => { calls += 1; return mockRes(status, body); },
      sleep: noSleep
    });
    assert.equal(res.sent, false);
    assert.equal(res.attempted, true);
    assert.equal(res.code, EMAIL_ERROR_CODES.INVALID_API_KEY, `status ${status} ${JSON.stringify(body)}`);
    assert.equal(res.retryable, false);
    assert.equal(res.attempts, 1);
    assert.equal(calls, 1, "invalid API key must not be retried");
    assert.match(res.hint, /RESEND_API_KEY/);
    assert.match(res.hint, /re_/);
  }
});

test("sendResendEmail classifies sandbox restriction and unverified domain (403) without retrying", async () => {
  let calls = 0;
  const sandbox = await sendResendEmail(sampleIncident, sampleAnalysis, "x", {
    config: makeCfg({ RESEND_FROM_EMAIL: "onboarding@resend.dev" }),
    fetchImpl: async () => {
      calls += 1;
      return mockRes(403, {
        statusCode: 403,
        name: "validation_error",
        message: "You can only send testing emails to your own email address (owner@example.com)."
      });
    },
    sleep: noSleep
  });
  assert.equal(sandbox.sent, false);
  assert.equal(sandbox.code, EMAIL_ERROR_CODES.SANDBOX_RECIPIENT_RESTRICTED);
  assert.equal(calls, 1);
  assert.match(sandbox.hint, /onboarding@resend\.dev/);

  calls = 0;
  const unverified = await sendResendEmail(sampleIncident, sampleAnalysis, "x", {
    config: makeCfg({ RESEND_FROM_EMAIL: "alerts@unverified.example" }),
    fetchImpl: async () => {
      calls += 1;
      return mockRes(403, {
        statusCode: 403,
        name: "validation_error",
        message: "The unverified.example domain is not verified."
      });
    },
    sleep: noSleep
  });
  assert.equal(unverified.sent, false);
  assert.equal(unverified.code, EMAIL_ERROR_CODES.DOMAIN_NOT_VERIFIED);
  assert.equal(calls, 1);
  assert.match(unverified.hint, /resend\.com\/domains/);
});

test("sendResendEmail distinguishes 429 quota_exceeded (no retry) from 429 rate_limited (retries with same Idempotency-Key)", async () => {
  // Quota exceeded -> NO retry
  let quotaCalls = 0;
  const quotaRes = await sendResendEmail(sampleIncident, sampleAnalysis, "x", {
    config: makeCfg({ RESEND_MAX_RETRIES: 3 }),
    fetchImpl: async () => {
      quotaCalls += 1;
      return mockRes(429, { statusCode: 429, name: "daily_quota_exceeded", message: "You have reached your daily email sending quota." });
    },
    sleep: noSleep
  });
  assert.equal(quotaRes.sent, false);
  assert.equal(quotaRes.code, EMAIL_ERROR_CODES.QUOTA_EXCEEDED);
  assert.equal(quotaRes.retryable, false);
  assert.equal(quotaCalls, 1);

  // Rate limited -> retries and succeeds with same Idempotency-Key
  const seenKeys = [];
  const delays = [];
  let rateCalls = 0;
  const rateRes = await sendResendEmail(sampleIncident, sampleAnalysis, "x", {
    config: makeCfg({ RESEND_MAX_RETRIES: 2 }),
    fetchImpl: async (_url, init) => {
      rateCalls += 1;
      seenKeys.push(init.headers["Idempotency-Key"]);
      if (rateCalls === 1) {
        return mockRes(429, { statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests." }, { "retry-after": "1" });
      }
      return mockRes(200, { id: "email_after_429" });
    },
    sleep: async ms => { delays.push(ms); }
  });
  assert.equal(rateRes.sent, true);
  assert.equal(rateRes.id, "email_after_429");
  assert.equal(rateRes.attempts, 2);
  assert.equal(seenKeys[0], seenKeys[1], "retries must reuse exact same Idempotency-Key");
  assert.equal(delays[0], 1000, "should honor Retry-After header");
});

test("sendResendEmail retries transient 5xx and exhausts gracefully if provider stays down", async () => {
  let calls = 0;
  const recovered = await sendResendEmail(sampleIncident, sampleAnalysis, "x", {
    config: makeCfg({ RESEND_MAX_RETRIES: 2 }),
    retryBaseMs: 1,
    sleep: noSleep,
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) return mockRes(503, "Service Unavailable");
      return mockRes(200, { id: "email_recovered" });
    }
  });
  assert.equal(recovered.sent, true);
  assert.equal(recovered.id, "email_recovered");
  assert.equal(recovered.attempts, 3);

  calls = 0;
  const exhausted = await sendResendEmail(sampleIncident, sampleAnalysis, "x", {
    config: makeCfg({ RESEND_MAX_RETRIES: 2 }),
    retryBaseMs: 1,
    sleep: noSleep,
    fetchImpl: async () => {
      calls += 1;
      return mockRes(502, "Bad Gateway");
    }
  });
  assert.equal(exhausted.sent, false);
  assert.equal(exhausted.code, EMAIL_ERROR_CODES.PROVIDER_ERROR);
  assert.equal(exhausted.status, 502);
  assert.equal(exhausted.retryable, true);
  assert.equal(exhausted.attempts, 3);
  assert.equal(calls, 3);
});

test("sendResendEmail classifies timeouts, DNS/network cause codes, TLS errors (no retry), and bogus 200 HTML", async () => {
  // Timeout
  const timeoutRes = await sendResendEmail(sampleIncident, sampleAnalysis, "x", {
    config: makeCfg({ RESEND_MAX_RETRIES: 1 }),
    retryBaseMs: 1,
    sleep: noSleep,
    fetchImpl: async () => {
      const e = new Error("The operation was aborted");
      e.name = "AbortError";
      throw e;
    }
  });
  assert.equal(timeoutRes.sent, false);
  assert.equal(timeoutRes.code, EMAIL_ERROR_CODES.TIMEOUT);
  assert.equal(timeoutRes.attempts, 2);

  // Network error with Node undici cause
  const dnsRes = await sendResendEmail(sampleIncident, sampleAnalysis, "x", {
    config: makeCfg({ RESEND_MAX_RETRIES: 1 }),
    retryBaseMs: 1,
    sleep: noSleep,
    fetchImpl: async () => {
      const cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.resend.com"), { code: "ENOTFOUND" });
      throw new TypeError("fetch failed", { cause });
    }
  });
  assert.equal(dnsRes.sent, false);
  assert.equal(dnsRes.code, EMAIL_ERROR_CODES.NETWORK_ERROR);
  assert.equal(dnsRes.causeCode, "ENOTFOUND");
  assert.match(dnsRes.error, /ENOTFOUND/);

  // TLS error must NOT retry
  let tlsCalls = 0;
  const tlsRes = await sendResendEmail(sampleIncident, sampleAnalysis, "x", {
    config: makeCfg({ RESEND_MAX_RETRIES: 2 }),
    sleep: noSleep,
    fetchImpl: async () => {
      tlsCalls += 1;
      const cause = Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" });
      throw new TypeError("fetch failed", { cause });
    }
  });
  assert.equal(tlsRes.sent, false);
  assert.equal(tlsRes.code, EMAIL_ERROR_CODES.NETWORK_ERROR);
  assert.equal(tlsRes.retryable, false);
  assert.equal(tlsCalls, 1);

  // Proxy returning HTTP 200 HTML -> must NOT claim sent: true
  const proxyHtml = await sendResendEmail(sampleIncident, sampleAnalysis, "x", {
    config: makeCfg({ RESEND_MAX_RETRIES: 2 }),
    sleep: noSleep,
    fetchImpl: async () => mockRes(200, "<html><body>Proxy Login</body></html>")
  });
  assert.equal(proxyHtml.sent, false);
  assert.equal(proxyHtml.code, EMAIL_ERROR_CODES.INVALID_RESPONSE);
});

test("RESEND_API_KEY is never leaked in logs, return values, or getNotificationStatus()", async () => {
  const secret = "re_super_secret_token_987654321";
  const logs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => logs.push(a.join(" "));

  try {
    const cfg = makeCfg({ RESEND_API_KEY: secret });
    const res = await sendResendEmail(sampleIncident, sampleAnalysis, "x", {
      config: cfg,
      sleep: noSleep,
      fetchImpl: async () => mockRes(401, { statusCode: 401, name: "validation_error", message: "API key is invalid" })
    });
    const status = getNotificationStatus(cfg);

    const combined = JSON.stringify({ res, status, logs });
    assert.ok(!combined.includes(secret), "raw API key must never appear anywhere in logs, errors, or status");
    assert.equal(status.hasApiKey, true);
    assert.equal(status.apiKeyHint, "re_…4321");
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
});

/* ── 5. verifyResendConfig ──────────────────────────────────────────────── */

test("verifyResendConfig handles full-access keys, verified/unverified domains, sending-only keys, and invalid keys", async () => {
  // Full-access + verified domain
  const verified = await verifyResendConfig(makeCfg({ RESEND_FROM_EMAIL: "alerts@acme.io" }), {
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://api.resend.com/domains");
      assert.equal(init.headers["User-Agent"], USER_AGENT);
      return mockRes(200, { data: [{ name: "acme.io", status: "verified" }] });
    }
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.keyAccess, "full");
  assert.equal(verified.domainVerified, true);

  // Full-access + unverified domain
  const pending = await verifyResendConfig(makeCfg({ RESEND_FROM_EMAIL: "alerts@acme.io" }), {
    fetchImpl: async () => mockRes(200, { data: [{ name: "acme.io", status: "pending" }] })
  });
  assert.equal(pending.ok, false);
  assert.equal(pending.keyValid, true);
  assert.equal(pending.code, EMAIL_ERROR_CODES.DOMAIN_NOT_VERIFIED);

  // Full-access + missing domain
  const missingDom = await verifyResendConfig(makeCfg({ RESEND_FROM_EMAIL: "alerts@other.io" }), {
    fetchImpl: async () => mockRes(200, { data: [{ name: "acme.io", status: "verified" }] })
  });
  assert.equal(missingDom.ok, false);
  assert.equal(missingDom.code, EMAIL_ERROR_CODES.DOMAIN_NOT_VERIFIED);
  assert.equal(missingDom.domainStatus, "not_found");

  // Full-access + sandbox sender
  const sandbox = await verifyResendConfig(makeCfg({ RESEND_FROM_EMAIL: "onboarding@resend.dev" }), {
    fetchImpl: async () => mockRes(200, { data: [] })
  });
  assert.equal(sandbox.ok, true);
  assert.equal(sandbox.sandbox, true);

  // Sending-only key (Resend returns 401 restricted_api_key on GET /domains) -> VALID!
  const sendOnly = await verifyResendConfig(makeCfg(), {
    fetchImpl: async () => mockRes(401, {
      statusCode: 401,
      name: "restricted_api_key",
      message: "This API key is restricted to only send emails"
    })
  });
  assert.equal(sendOnly.ok, true);
  assert.equal(sendOnly.keyValid, true);
  assert.equal(sendOnly.keyAccess, "sending_only");

  // Invalid key on GET /domains (real Resend returns HTTP 400 validation_error!)
  const badKey400 = await verifyResendConfig(makeCfg(), {
    fetchImpl: async () => mockRes(400, {
      statusCode: 400,
      name: "validation_error",
      message: "API key is invalid"
    })
  });
  assert.equal(badKey400.ok, false);
  assert.equal(badKey400.keyValid, false);
  assert.equal(badKey400.code, EMAIL_ERROR_CODES.INVALID_API_KEY);
});

/* ── 6. notifyEngineer ──────────────────────────────────────────────────── */

test("notifyEngineer reports resend channel when configured and preserves backwards-compatible shape", async () => {
  const prevKey = config.RESEND_API_KEY;
  const prevEmail = config.DEVELOPER_EMAIL;
  const prevWebhook = config.NOTIFICATION_WEBHOOK_URL;
  config.RESEND_API_KEY = "re_test_1234567890";
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
    assert.equal(res.channel, "log+resend");
    assert.equal(res.email.id, "email_456");
  } finally {
    config.RESEND_API_KEY = prevKey;
    config.DEVELOPER_EMAIL = prevEmail;
    config.NOTIFICATION_WEBHOOK_URL = prevWebhook;
  }
});

test("notifyEngineer reports detailed errors on invalid token, partial misconfig, webhook+mail partial failure, and survives partial analysis", async () => {
  // Invalid token
  const failMail = await notifyEngineer(sampleIncident, sampleAnalysis, "500 spike", {
    config: makeCfg(),
    sleep: noSleep,
    fetchImpl: async () => mockRes(401, { statusCode: 401, name: "validation_error", message: "API key is invalid" })
  });
  assert.equal(failMail.sent, false);
  assert.equal(failMail.channel, "log");
  assert.equal(failMail.email.code, EMAIL_ERROR_CODES.INVALID_API_KEY);
  assert.equal(failMail.errors.length, 1);
  assert.equal(failMail.errors[0].channel, "resend");

  // Partially configured (key set, no email) -> NOT silently ignored
  const partial = await notifyEngineer(sampleIncident, sampleAnalysis, "500 spike", {
    config: makeCfg({ DEVELOPER_EMAIL: undefined }),
    fetchImpl: async () => { throw new Error("must not call fetch"); }
  });
  assert.equal(partial.sent, false);
  assert.equal(partial.email.code, EMAIL_ERROR_CODES.MISSING_RECIPIENT);

  // Webhook succeeds, email fails -> channel has webhook, sent=false, errors has resend
  const mixed = await notifyEngineer(sampleIncident, sampleAnalysis, "500 spike", {
    config: makeCfg({ NOTIFICATION_WEBHOOK_URL: "https://hooks.example.com/sbwk" }),
    sleep: noSleep,
    fetchImpl: async (url) => {
      if (url.includes("hooks.example.com")) return mockRes(200, { ok: true });
      return mockRes(401, { statusCode: 401, name: "validation_error", message: "API key is invalid" });
    }
  });
  assert.equal(mixed.channel, "log+webhook");
  assert.equal(mixed.sent, false);
  assert.equal(mixed.webhook.sent, true);
  assert.equal(mixed.email.sent, false);

  // Partial/null analysis must never throw (even with webhook enabled)
  const safeRes = await notifyEngineer({ id: "inc-partial" }, {}, "manual check", {
    config: makeCfg({ NOTIFICATION_WEBHOOK_URL: "https://hooks.example.com/sbwk" }),
    fetchImpl: async () => mockRes(200, { id: "email_safe" })
  });
  assert.equal(safeRes.sent, true);
  assert.equal(safeRes.channel, "log+webhook+resend");
});

/* ── 7. Investigator integration ────────────────────────────────────────── */

test("createInvestigator surfaces Resend failures as incident warnings without breaking diagnosis", async () => {
  const store = new IncidentStore(50);
  const cfg = makeCfg({ ESCALATION_CONFIDENCE_THRESHOLD: 0.5, RESEND_NOTIFY_ALL_INCIDENTS: true });
  const inv = createInvestigator({
    store,
    investigateDependencies: async () => ({
      results: [{ service: "database", check: "health", status: "unhealthy", data: { status: "unhealthy" } }]
    }),
    inspectCodebase: async () => [],
    reason: async input => heuristicReason(input),
    triage: async () => ({ provider: "liquid", ok: true, skipped: true, status: "not_configured", route: "groq", warnings: [], reasons: [] }),
    notifyEngineer: (inc, analysis, reason, opts) =>
      notifyEngineer(inc, analysis, reason, {
        ...opts,
        sleep: noSleep,
        fetchImpl: async () => mockRes(401, { statusCode: 401, name: "validation_error", message: "API key is invalid" })
      }),
    config: cfg,
    services: ["database"]
  });

  const rec = await inv.runInvestigation(sampleIncident);
  assert.equal(rec.status, "analyzed");
  assert.equal(rec.analysis.escalate, false);
  assert.ok(rec.notification, "RESEND_NOTIFY_ALL_INCIDENTS=true must still notify on non-escalated faults");
  assert.equal(rec.notification.sent, false);
  assert.equal(rec.notification.email.code, EMAIL_ERROR_CODES.INVALID_API_KEY);
  const mailWarn = rec.analysis.warnings.find(w => w.source === "resend");
  assert.ok(mailWarn, "email delivery failure must be surfaced in analysis.warnings");
  assert.equal(mailWarn.severity, "error");
  assert.match(mailWarn.message, /invalid_api_key/);
});

/* ── 8. End-to-End HTTP test: real agent-core server + mock Resend API ─── */

async function startMockResendServer() {
  const state = {
    mode: "ok", // "ok" | "invalid_key" | "sending_only" | "unverified_domain" | "flaky_once"
    requests: [],
    emailAttemptCount: 0
  };
  const srv = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const parsedBody = bodyText ? JSON.parse(bodyText) : null;
    state.requests.push({ method: req.method, url: req.url, headers: req.headers, body: parsedBody });

    if (!req.headers["user-agent"]) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ statusCode: 403, name: "forbidden", message: "Missing User-Agent" }));
    }

    if (req.url === "/domains" && req.method === "GET") {
      if (state.mode === "invalid_key") {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ statusCode: 400, name: "validation_error", message: "API key is invalid" }));
      }
      if (state.mode === "sending_only") {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ statusCode: 401, name: "restricted_api_key", message: "This API key is restricted to only send emails" }));
      }
      if (state.mode === "unverified_domain") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ data: [{ name: "example.com", status: "pending" }] }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ data: [{ name: "example.com", status: "verified" }] }));
    }

    if (req.url === "/emails" && req.method === "POST") {
      state.emailAttemptCount += 1;
      if (state.mode === "invalid_key") {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ statusCode: 401, name: "validation_error", message: "API key is invalid" }));
      }
      if (state.mode === "flaky_once" && state.emailAttemptCount === 1) {
        res.writeHead(503, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ statusCode: 503, name: "application_error", message: "Temporary outage" }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ id: `em_live_${state.emailAttemptCount}` }));
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise(resolve => srv.listen(0, "127.0.0.1", resolve));
  const port = srv.address().port;
  return { server: srv, url: `http://127.0.0.1:${port}`, state };
}

async function waitHealthy(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* booting */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

test("E2E: agent-core HTTP server verifies token, retries transient errors, alerts on incidents, and handles invalid tokens safely", async () => {
  resetNotificationTelemetry();
  const mockResend = await startMockResendServer();
  const token = "e2e-test-agent-core-token-1234567890";
  // Pick an ephemeral free port for agent-core
  const probeSrv = http.createServer();
  await new Promise(r => probeSrv.listen(0, "127.0.0.1", r));
  const corePort = probeSrv.address().port;
  await new Promise(r => probeSrv.close(r));

  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: agentCoreDir,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "development",
      PORT: String(corePort),
      AGENT_CORE_TOKEN: token,
      AGENT_MODE: "mock",
      CONNECTOR_URL: "http://127.0.0.1:1",
      RESEND_API_KEY: "re_e2e_valid_token_9999",
      DEVELOPER_EMAIL: "dev@example.com, ops@example.com",
      RESEND_FROM_EMAIL: "alerts@example.com",
      RESEND_API_BASE_URL: mockResend.url,
      RESEND_NOTIFY_ALL_INCIDENTS: "true",
      RESEND_MAX_RETRIES: "2",
      RESEND_TIMEOUT_MS: "3000"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const coreBase = `http://127.0.0.1:${corePort}`;
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  try {
    await waitHealthy(`${coreBase}/health`);

    // 1. Auth required on /notifications/status
    const unauth = await fetch(`${coreBase}/notifications/status`);
    assert.equal(unauth.status, 401);

    // 2. Status endpoint reports ready & redacts key
    const statusRes = await (await fetch(`${coreBase}/notifications/status`, { headers: auth })).json();
    assert.equal(statusRes.success, true);
    assert.equal(statusRes.notifications.state, "ready");
    assert.deepEqual(statusRes.notifications.recipients, ["dev@example.com", "ops@example.com"]);
    assert.equal(statusRes.notifications.apiKeyHint, "re_…9999");
    assert.ok(!JSON.stringify(statusRes).includes("re_e2e_valid_token_9999"));

    // 3. Verify token — full access + verified domain
    const vFull = await (await fetch(`${coreBase}/notifications/verify`, { method: "POST", headers: auth, body: "{}" })).json();
    assert.equal(vFull.verification.ok, true);
    assert.equal(vFull.verification.keyAccess, "full");
    assert.equal(vFull.verification.domainVerified, true);

    // 4. Verify token — sending-only key
    mockResend.state.mode = "sending_only";
    const vSendOnly = await (await fetch(`${coreBase}/notifications/verify`, { method: "POST", headers: auth, body: "{}" })).json();
    assert.equal(vSendOnly.verification.ok, true);
    assert.equal(vSendOnly.verification.keyAccess, "sending_only");

    // 5. Verify token — invalid key (400 validation_error)
    mockResend.state.mode = "invalid_key";
    const vInvalid = await (await fetch(`${coreBase}/notifications/verify`, { method: "POST", headers: auth, body: "{}" })).json();
    assert.equal(vInvalid.verification.ok, false);
    assert.equal(vInvalid.verification.code, EMAIL_ERROR_CODES.INVALID_API_KEY);

    // 6. Test email with transient 503 -> retries and succeeds with same Idempotency-Key
    mockResend.state.mode = "flaky_once";
    mockResend.state.emailAttemptCount = 0;
    mockResend.state.requests.length = 0;
    const testMail = await (await fetch(`${coreBase}/notifications/test`, { method: "POST", headers: auth, body: "{}" })).json();
    assert.equal(testMail.result.sent, true);
    assert.equal(testMail.result.attempts, 2);
    const emailReqs = mockResend.state.requests.filter(r => r.url === "/emails");
    assert.equal(emailReqs.length, 2);
    assert.equal(emailReqs[0].headers["idempotency-key"], emailReqs[1].headers["idempotency-key"]);

    // 7. Real incident -> analysis + Resend email delivered
    mockResend.state.mode = "ok";
    const incOk = await (await fetch(`${coreBase}/incidents?wait=true`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ ...sampleIncident, id: "e2e-inc-ok" })
    })).json();
    assert.equal(incOk.incident.status, "analyzed");
    assert.equal(incOk.incident.notification.sent, true);
    assert.equal(incOk.incident.notification.channel, "log+resend");
    assert.ok(incOk.incident.notification.email.id);

    // 8. Real incident with INVALID token -> analysis still succeeds, warning surfaced, error recorded
    mockResend.state.mode = "invalid_key";
    const incBad = await (await fetch(`${coreBase}/incidents?wait=true`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ ...sampleIncident, id: "e2e-inc-bad-token" })
    })).json();
    assert.equal(incBad.incident.status, "analyzed");
    assert.equal(incBad.incident.notification.sent, false);
    assert.equal(incBad.incident.notification.email.code, EMAIL_ERROR_CODES.INVALID_API_KEY);
    assert.ok(incBad.incident.analysis.warnings.some(w => w.source === "resend" && w.severity === "error"));

    // 9. Runtime config update via POST /config updates notification settings without leaking key
    const cfgUpdate = await (await fetch(`${coreBase}/config`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ notifications: { resendApiKey: "re_rotated_key_5555", developerEmail: "oncall@example.com", notifyAllIncidents: false } })
    })).json();
    assert.equal(cfgUpdate.config.notifications.apiKeyHint, "re_…5555");
    assert.deepEqual(cfgUpdate.config.notifications.recipients, ["oncall@example.com"]);
    assert.equal(cfgUpdate.config.notifications.notifyAllIncidents, false);
    assert.ok(!JSON.stringify(cfgUpdate).includes("re_rotated_key_5555"));
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => {
      const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(); }, 3000);
      child.once("exit", () => { clearTimeout(t); resolve(); });
    });
    await new Promise(resolve => mockResend.server.close(resolve));
  }
});
