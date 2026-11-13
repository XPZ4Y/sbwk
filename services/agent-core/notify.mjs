// Notification -> Developer Team. Always logs; optionally posts to a webhook
// and/or sends fault alert emails via Resend.com (zero external dependencies).
import { createHash, randomUUID } from "node:crypto";
import { config as defaultConfig } from "./config.mjs";
import { redactKey } from "./ai-debug.mjs";

export const DEFAULT_RESEND_BASE_URL = "https://api.resend.com";
export const DEFAULT_RESEND_FROM = "onboarding@resend.dev";
export const DEFAULT_RESEND_TIMEOUT_MS = 10000;
export const DEFAULT_RESEND_MAX_RETRIES = 2;
export const DEFAULT_RETRY_BASE_MS = 500;
export const MAX_RETRY_DELAY_MS = 5000;
export const MAX_RECIPIENTS = 50;
export const USER_AGENT = "sbwk-agent-core/2.1";

export const EMAIL_ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: "not_configured",
  MISSING_API_KEY: "missing_api_key",
  MISSING_RECIPIENT: "missing_recipient",
  INVALID_API_KEY: "invalid_api_key",
  RESTRICTED_API_KEY: "restricted_api_key",
  INVALID_RECIPIENT_EMAIL: "invalid_recipient_email",
  INVALID_FROM_EMAIL: "invalid_from_email",
  INVALID_BASE_URL: "invalid_base_url",
  DOMAIN_NOT_VERIFIED: "domain_not_verified",
  SANDBOX_RECIPIENT_RESTRICTED: "sandbox_recipient_restricted",
  VALIDATION_ERROR: "validation_error",
  IDEMPOTENCY_CONFLICT: "idempotency_conflict",
  RATE_LIMITED: "rate_limited",
  QUOTA_EXCEEDED: "quota_exceeded",
  FORBIDDEN: "forbidden",
  PROVIDER_ERROR: "provider_error",
  TIMEOUT: "timeout",
  NETWORK_ERROR: "network_error",
  INVALID_RESPONSE: "invalid_response",
  UNEXPECTED_ERROR: "unexpected_error"
});

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;
const TLS_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"
]);

// Bounded in-memory telemetry (never stores secrets).
let telemetry = freshTelemetry();
function freshTelemetry() {
  return {
    email: { sent: 0, failed: 0, skipped: 0, lastSuccessAt: null, lastFailureAt: null, lastAttempt: null },
    webhook: { sent: 0, failed: 0, lastAttempt: null }
  };
}
export function resetNotificationTelemetry() {
  telemetry = freshTelemetry();
}

function logEvent(level, event, fields = {}) {
  const fn = level === "error" ? console.error : console.log;
  fn(JSON.stringify({ level, event, service: "agent-core", timestamp: new Date().toISOString(), ...fields }));
}

export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function sanitizeSubject(str, maxLen = 200) {
  const cleaned = String(str ?? "")
    .replace(/[\r\n\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "[SBWK] Application Fault Detected";
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}

/** Validate a bare email address (local@domain.tld). */
function isValidBareEmail(addr) {
  if (typeof addr !== "string") return false;
  const s = addr.trim();
  if (!s || s.length > 254 || CONTROL_CHARS_RE.test(s) || /\s/.test(s)) return false;
  const at = s.indexOf("@");
  if (at <= 0 || at > 64 || at !== s.lastIndexOf("@")) return false;
  const local = s.slice(0, at);
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  return EMAIL_RE.test(s);
}

/**
 * Parse either `user@example.com` or `Display Name <user@example.com>`.
 * Returns null if invalid or containing unsafe control characters.
 */
export function parseEmailAddress(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 320 || CONTROL_CHARS_RE.test(trimmed)) return null;

  const angleMatch = trimmed.match(/^(.+?)\s*<([^<>]+)>$/);
  if (angleMatch) {
    const displayName = angleMatch[1].trim().replace(/^"(.*)"$/, "$1").trim();
    const address = angleMatch[2].trim();
    if (!displayName || !isValidBareEmail(address)) return null;
    const domain = address.slice(address.indexOf("@") + 1).toLowerCase();
    return { formatted: `${displayName} <${address}>`, displayName, address, domain };
  }

  if (!isValidBareEmail(trimmed)) return null;
  const domain = trimmed.slice(trimmed.indexOf("@") + 1).toLowerCase();
  return { formatted: trimmed, displayName: null, address: trimmed, domain };
}

/**
 * Parse single or comma/semicolon-separated recipient list (or array of strings).
 * Deduplicates case-insensitively and enforces Resend's 50-recipient limit.
 */
export function parseRecipients(raw) {
  const parts = Array.isArray(raw)
    ? raw.flatMap(item => String(item ?? "").split(/[,;]+/))
    : typeof raw === "string"
      ? raw.split(/[,;]+/)
      : [];

  const valid = [];
  const invalid = [];
  const seen = new Set();

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const parsed = parseEmailAddress(trimmed);
    if (!parsed) {
      invalid.push(trimmed);
      continue;
    }
    const key = parsed.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push(parsed.formatted);
  }

  const truncated = valid.length > MAX_RECIPIENTS ? valid.length - MAX_RECIPIENTS : 0;
  return { valid: valid.slice(0, MAX_RECIPIENTS), invalid, truncated };
}

export function validateFromAddress(raw) {
  const input = typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULT_RESEND_FROM;
  const parsed = parseEmailAddress(input);
  if (!parsed) {
    return {
      ok: false,
      value: input,
      address: null,
      domain: null,
      isSandbox: false,
      error: `Invalid RESEND_FROM_EMAIL address: "${input.slice(0, 80)}"`,
      hint: "Use a valid email like 'onboarding@resend.dev' or 'SBWK Alerts <alerts@yourdomain.com>'."
    };
  }
  return {
    ok: true,
    value: parsed.formatted,
    address: parsed.address,
    domain: parsed.domain,
    isSandbox: parsed.domain === "resend.dev"
  };
}

export function validateApiKey(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { present: false, ok: false, key: undefined, formatOk: false };
  }
  const str = String(raw).trim();
  if (CONTROL_CHARS_RE.test(str) || /\s/.test(str)) {
    return {
      present: true,
      ok: false,
      key: undefined,
      formatOk: false,
      error: "RESEND_API_KEY contains whitespace or control characters (cannot be sent in Authorization header).",
      hint: "Copy the API key cleanly from https://resend.com/api-keys with no spaces or newlines."
    };
  }
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    return {
      present: true,
      ok: false,
      key: undefined,
      formatOk: false,
      error: "RESEND_API_KEY contains literal quote characters.",
      hint: "Remove surrounding quotes from RESEND_API_KEY in your environment configuration."
    };
  }
  const formatOk = /^re_[A-Za-z0-9_]{8,}$/.test(str);
  return {
    present: true,
    ok: true,
    key: str,
    formatOk,
    warning: formatOk
      ? undefined
      : "RESEND_API_KEY does not match Resend's standard 're_...' prefix — it may be invalid."
  };
}

function validateBaseUrl(raw) {
  const candidate = typeof raw === "string" && raw.trim() ? raw.trim().replace(/\/+$/, "") : DEFAULT_RESEND_BASE_URL;
  try {
    const u = new URL(candidate);
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      return { ok: false, value: candidate, error: `RESEND_API_BASE_URL must use http:// or https:// (got ${u.protocol})` };
    }
    if (u.username || u.password) {
      return { ok: false, value: candidate, error: "RESEND_API_BASE_URL must not embed credentials" };
    }
    return { ok: true, value: `${u.origin}${u.pathname}`.replace(/\/+$/, "") };
  } catch {
    return { ok: false, value: candidate, error: `RESEND_API_BASE_URL is not a valid URL: "${candidate.slice(0, 80)}"` };
  }
}

/**
 * Inspect mail configuration and classify it into:
 *   - "not_configured": neither RESEND_API_KEY nor DEVELOPER_EMAIL is set (clean opt-out)
 *   - "misconfigured":  partially configured OR invalid key/email/from/baseUrl
 *   - "ready":          all required settings present and locally valid
 */
export function validateMailConfig(cfg = defaultConfig) {
  const c = cfg || {};
  const keyCheck = validateApiKey(c.RESEND_API_KEY);
  const rawRecipient = typeof c.DEVELOPER_EMAIL === "string" ? c.DEVELOPER_EMAIL.trim() : "";
  const hasRecipientRaw = Array.isArray(c.DEVELOPER_EMAIL)
    ? c.DEVELOPER_EMAIL.some(x => String(x || "").trim())
    : Boolean(rawRecipient);
  const recipientsCheck = parseRecipients(c.DEVELOPER_EMAIL);
  const fromCheck = validateFromAddress(c.RESEND_FROM_EMAIL);
  const baseUrlCheck = validateBaseUrl(c.RESEND_API_BASE_URL);
  const notifyAllIncidents = c.RESEND_NOTIFY_ALL_INCIDENTS !== false;
  const timeoutMs = Number.isFinite(Number(c.RESEND_TIMEOUT_MS)) && Number(c.RESEND_TIMEOUT_MS) >= 100
    ? Math.min(60000, Math.round(Number(c.RESEND_TIMEOUT_MS)))
    : (Number.isFinite(Number(c.REQUEST_TIMEOUT_MS)) && Number(c.REQUEST_TIMEOUT_MS) >= 100 ? Number(c.REQUEST_TIMEOUT_MS) : DEFAULT_RESEND_TIMEOUT_MS);
  const maxRetries = Number.isFinite(Number(c.RESEND_MAX_RETRIES)) && Number(c.RESEND_MAX_RETRIES) >= 0
    ? Math.min(5, Math.round(Number(c.RESEND_MAX_RETRIES)))
    : DEFAULT_RESEND_MAX_RETRIES;

  const errors = [];
  const warnings = [];

  const neitherSet = !keyCheck.present && !hasRecipientRaw;
  const partiallyConfigured = keyCheck.present !== hasRecipientRaw;

  if (!neitherSet) {
    if (!keyCheck.present) {
      errors.push({
        code: EMAIL_ERROR_CODES.MISSING_API_KEY,
        field: "RESEND_API_KEY",
        message: "DEVELOPER_EMAIL is set but RESEND_API_KEY is missing.",
        hint: "Set RESEND_API_KEY in .env (get one at https://resend.com/api-keys)."
      });
    } else if (!keyCheck.ok) {
      errors.push({
        code: EMAIL_ERROR_CODES.INVALID_API_KEY,
        field: "RESEND_API_KEY",
        message: keyCheck.error,
        hint: keyCheck.hint
      });
    } else if (keyCheck.warning) {
      warnings.push({ code: "api_key_format", field: "RESEND_API_KEY", message: keyCheck.warning });
    }

    if (!hasRecipientRaw) {
      errors.push({
        code: EMAIL_ERROR_CODES.MISSING_RECIPIENT,
        field: "DEVELOPER_EMAIL",
        message: "RESEND_API_KEY is set but DEVELOPER_EMAIL is missing.",
        hint: "Set DEVELOPER_EMAIL in .env (comma-separated addresses are supported)."
      });
    } else {
      if (recipientsCheck.invalid.length > 0) {
        errors.push({
          code: EMAIL_ERROR_CODES.INVALID_RECIPIENT_EMAIL,
          field: "DEVELOPER_EMAIL",
          message: `Invalid recipient email address(es): ${recipientsCheck.invalid.slice(0, 5).join(", ")}`,
          hint: "Provide valid email address(es) in DEVELOPER_EMAIL (e.g. 'dev@example.com' or 'a@co.com, b@co.com')."
        });
      } else if (recipientsCheck.valid.length === 0) {
        errors.push({
          code: EMAIL_ERROR_CODES.INVALID_RECIPIENT_EMAIL,
          field: "DEVELOPER_EMAIL",
          message: "DEVELOPER_EMAIL did not contain any valid email address.",
          hint: "Set DEVELOPER_EMAIL to a valid email address."
        });
      }
      if (recipientsCheck.truncated > 0) {
        warnings.push({
          code: "recipients_truncated",
          field: "DEVELOPER_EMAIL",
          message: `DEVELOPER_EMAIL exceeded Resend's ${MAX_RECIPIENTS}-recipient limit; ${recipientsCheck.truncated} address(es) were omitted.`
        });
      }
    }

    if (!fromCheck.ok) {
      errors.push({
        code: EMAIL_ERROR_CODES.INVALID_FROM_EMAIL,
        field: "RESEND_FROM_EMAIL",
        message: fromCheck.error,
        hint: fromCheck.hint
      });
    } else if (fromCheck.isSandbox) {
      warnings.push({
        code: "sandbox_sender",
        field: "RESEND_FROM_EMAIL",
        message: `Using Resend sandbox sender (${fromCheck.address}): delivery is restricted to your Resend account owner email until you verify a custom domain.`
      });
    }

    if (!baseUrlCheck.ok) {
      errors.push({
        code: EMAIL_ERROR_CODES.INVALID_BASE_URL,
        field: "RESEND_API_BASE_URL",
        message: baseUrlCheck.error,
        hint: `Set RESEND_API_BASE_URL to ${DEFAULT_RESEND_BASE_URL} (or leave unset).`
      });
    }
  }

  const state = neitherSet ? "not_configured" : (errors.length === 0 ? "ready" : "misconfigured");
  return {
    state,
    configured: keyCheck.present && hasRecipientRaw,
    partiallyConfigured,
    valid: state === "ready",
    provider: "resend",
    hasApiKey: keyCheck.present,
    apiKeyHint: keyCheck.ok ? redactKey(keyCheck.key) : null,
    apiKeyFormatOk: keyCheck.formatOk,
    from: fromCheck.value,
    fromAddress: fromCheck.address,
    fromDomain: fromCheck.domain,
    isSandboxFrom: fromCheck.isSandbox,
    recipients: recipientsCheck.valid,
    invalidRecipients: recipientsCheck.invalid,
    notifyAllIncidents,
    apiBaseUrl: baseUrlCheck.value,
    timeoutMs,
    maxRetries,
    webhookConfigured: Boolean(c.NOTIFICATION_WEBHOOK_URL && String(c.NOTIFICATION_WEBHOOK_URL).trim()),
    errors,
    warnings,
    // Internal resolved key — NOT exposed by getNotificationStatus()
    _apiKey: keyCheck.ok ? keyCheck.key : undefined
  };
}

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v;
  }
  return null;
}

function parseRetryAfterMs(headers, maxDelayMs = MAX_RETRY_DELAY_MS) {
  const raw = getHeader(headers, "retry-after") || getHeader(headers, "ratelimit-reset");
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const num = Number(s);
    // ratelimit-reset can be relative seconds (small) or epoch seconds (large).
    const ms = num > 1_000_000_000 ? Math.max(0, num * 1000 - Date.now()) : num * 1000;
    return Math.min(Math.max(50, Math.round(ms)), maxDelayMs);
  }
  const dateMs = Date.parse(s);
  if (Number.isFinite(dateMs)) {
    return Math.min(Math.max(50, dateMs - Date.now()), maxDelayMs);
  }
  return null;
}

async function readResponseBody(res) {
  if (typeof res?.text === "function") {
    const text = await res.text().catch(() => "");
    if (!text) return { text: "", json: null, parseError: false };
    try {
      return { text, json: JSON.parse(text), parseError: false };
    } catch {
      return { text, json: null, parseError: true };
    }
  }
  if (typeof res?.json === "function") {
    try {
      const json = await res.json();
      return { text: JSON.stringify(json ?? {}), json, parseError: false };
    } catch {
      return { text: "", json: null, parseError: true };
    }
  }
  return { text: "", json: null, parseError: false };
}

/**
 * Map a Resend non-2xx HTTP response to a structured, actionable error object.
 * Handles Resend's real API responses across POST /emails and GET /domains
 * (including HTTP 400 validation_error "API key is invalid" on /domains).
 */
export function classifyResendHttpError(status, parsedJson, rawText, headers, apiKey) {
  const providerName = typeof parsedJson?.name === "string" ? parsedJson.name : null;
  const providerMessage = typeof parsedJson?.message === "string"
    ? parsedJson.message
    : (typeof parsedJson?.error === "string" ? parsedJson.error : "");
  const detail = (providerMessage || String(rawText || "").replace(/\s+/g, " ").trim()).slice(0, 300);
  const keyPrefixHint = apiKey && !apiKey.startsWith("re_")
    ? " Note: Resend API keys normally start with 're_'."
    : "";

  const isInvalidKeyMsg =
    providerName === "invalid_api_key" ||
    providerName === "missing_api_key" ||
    /api key is invalid|invalid api key|missing api key|api key.*not active|api key.*suspended|api key.*revoked|api key.*deleted/i.test(providerMessage);

  const isRestrictedKey =
    !isInvalidKeyMsg &&
    (providerName === "restricted_api_key" ||
      /restricted to only send/i.test(providerMessage));

  const retryAfterMs = parseRetryAfterMs(headers);

  // 1. Restricted sending-only key (Resend returns 401 or 403)
  if ((status === 401 || status === 403) && isRestrictedKey) {
    return {
      code: EMAIL_ERROR_CODES.RESTRICTED_API_KEY,
      status,
      retryable: false,
      providerName,
      providerError: detail || "API key has restricted permissions",
      message: `Resend API key permission restriction (HTTP ${status}): ${detail || "restricted key"}`,
      hint: "This key has limited permissions in Resend. Verify its scope at https://resend.com/api-keys."
    };
  }

  // 2. Invalid / missing / inactive API key (Resend returns 401 on /emails, 400 on /domains, or 403)
  if ((status === 400 || status === 401 || status === 403) && (status === 401 || isInvalidKeyMsg)) {
    return {
      code: EMAIL_ERROR_CODES.INVALID_API_KEY,
      status,
      retryable: false,
      providerName,
      providerError: detail || "API key is invalid",
      message: `Resend rejected the API key (HTTP ${status}): ${detail || "invalid or unauthorized API key"}`,
      hint: `Verify RESEND_API_KEY in .env or generate a new key at https://resend.com/api-keys.${keyPrefixHint}`
    };
  }

  // 3. Forbidden (403): sandbox recipient restriction, unverified domain, or Cloudflare/WAF block
  if (status === 403) {
    if (/only send testing emails to your own email address|testing emails/i.test(providerMessage)) {
      return {
        code: EMAIL_ERROR_CODES.SANDBOX_RECIPIENT_RESTRICTED,
        status,
        retryable: false,
        providerName,
        providerError: detail,
        message: `Resend sandbox restriction (HTTP 403): ${detail}`,
        hint: "onboarding@resend.dev can only deliver to your own Resend account email. Verify a domain at https://resend.com/domains and set RESEND_FROM_EMAIL to send to other recipients."
      };
    }
    if (/domain.*not verified|verify.*domain|not verified/i.test(providerMessage)) {
      return {
        code: EMAIL_ERROR_CODES.DOMAIN_NOT_VERIFIED,
        status,
        retryable: false,
        providerName,
        providerError: detail,
        message: `Resend sender domain is not verified (HTTP 403): ${detail}`,
        hint: "Verify the RESEND_FROM_EMAIL domain at https://resend.com/domains, or use onboarding@resend.dev for testing to your account email."
      };
    }
    return {
      code: EMAIL_ERROR_CODES.FORBIDDEN,
      status,
      retryable: false,
      providerName,
      providerError: detail || "Forbidden",
      message: `Resend rejected the request (HTTP 403): ${detail || "forbidden"}`,
      hint: "Check your Resend API key permissions, verified sender domain, and account status."
    };
  }

  // 4. Payload / validation errors (400 / 422)
  if (status === 400 || status === 422) {
    const isFromErr = providerName === "invalid_from_address" || /invalid.*from/i.test(providerMessage);
    return {
      code: isFromErr ? EMAIL_ERROR_CODES.INVALID_FROM_EMAIL : EMAIL_ERROR_CODES.VALIDATION_ERROR,
      status,
      retryable: false,
      providerName,
      providerError: detail || "Validation error",
      message: `Resend validation error (HTTP ${status}): ${detail || "invalid email parameters"}`,
      hint: isFromErr
        ? "Check RESEND_FROM_EMAIL format and ensure its domain is verified in Resend."
        : "Check DEVELOPER_EMAIL, RESEND_FROM_EMAIL, and email payload parameters."
    };
  }

  // 5. Idempotency conflict (409)
  if (status === 409) {
    const concurrent = providerName === "concurrent_idempotent_requests";
    return {
      code: EMAIL_ERROR_CODES.IDEMPOTENCY_CONFLICT,
      status,
      retryable: concurrent,
      retryAfterMs: concurrent ? (retryAfterMs || 500) : null,
      providerName,
      providerError: detail || "Idempotency conflict",
      message: `Resend idempotency conflict (HTTP 409): ${detail || "duplicate or concurrent idempotency key"}`,
      hint: concurrent ? "A request with the same Idempotency-Key is already in flight; retrying." : "Use a unique Idempotency-Key for distinct payloads."
    };
  }

  // 6. Rate limit vs quota exceeded (429)
  if (status === 429) {
    const isQuota =
      providerName === "daily_quota_exceeded" ||
      providerName === "monthly_quota_exceeded" ||
      /daily.*quota|monthly.*quota|quota exceeded/i.test(providerMessage);
    if (isQuota) {
      return {
        code: EMAIL_ERROR_CODES.QUOTA_EXCEEDED,
        status,
        retryable: false,
        providerName,
        providerError: detail || "Resend sending quota exceeded",
        message: `Resend sending quota exceeded (HTTP 429): ${detail || "daily or monthly limit reached"}`,
        hint: "Your Resend plan's daily or monthly email quota is exhausted. Wait for quota reset or upgrade your Resend plan."
      };
    }
    return {
      code: EMAIL_ERROR_CODES.RATE_LIMITED,
      status,
      retryable: true,
      retryAfterMs,
      providerName,
      providerError: detail || "Rate limit exceeded",
      message: `Resend rate limit exceeded (HTTP 429): ${detail || "too many requests"}`,
      hint: "Too many emails sent per second; SBWK backs off automatically. Consider setting RESEND_NOTIFY_ALL_INCIDENTS=false under high error rates."
    };
  }

  // 7. Provider 5xx errors (retryable)
  if (status >= 500) {
    return {
      code: EMAIL_ERROR_CODES.PROVIDER_ERROR,
      status,
      retryable: true,
      retryAfterMs,
      providerName,
      providerError: detail || `HTTP ${status}`,
      message: `Resend server error (HTTP ${status}): ${detail || "upstream service temporarily unavailable"}`,
      hint: "Resend API returned a server error. Check https://resend-status.com if this persists."
    };
  }

  return {
    code: EMAIL_ERROR_CODES.PROVIDER_ERROR,
    status,
    retryable: false,
    providerName,
    providerError: detail || `HTTP ${status}`,
    message: `Unexpected Resend response (HTTP ${status}): ${detail || "request failed"}`,
    hint: "Inspect agent-core logs for full Resend API response details."
  };
}

/** Map fetch exceptions (timeouts, DNS, TCP, TLS) with Node's underlying `err.cause`. */
export function classifyNetworkError(err, timeoutMs = DEFAULT_RESEND_TIMEOUT_MS) {
  const causeCode = err?.cause?.code || err?.code || null;
  const causeMsg = err?.cause?.message || "";
  const rawMsg = err?.message || String(err || "unknown network error");
  const isTimeout =
    err?.name === "AbortError" ||
    err?.name === "TimeoutError" ||
    causeCode === "UND_ERR_HEADERS_TIMEOUT" ||
    causeCode === "UND_ERR_BODY_TIMEOUT" ||
    causeCode === "ETIMEDOUT";

  if (isTimeout) {
    return {
      code: EMAIL_ERROR_CODES.TIMEOUT,
      status: 0,
      retryable: true,
      causeCode: causeCode || "ABORT_ERR",
      message: `Resend API request timed out after ${timeoutMs}ms`,
      hint: "Check outbound HTTPS connectivity to api.resend.com or increase RESEND_TIMEOUT_MS."
    };
  }

  const isTls = Boolean(causeCode && (TLS_ERROR_CODES.has(causeCode) || String(causeCode).startsWith("ERR_TLS_")));
  const detail = [causeCode, causeMsg && causeMsg !== rawMsg ? causeMsg : null, rawMsg].filter(Boolean).join(" — ");

  return {
    code: EMAIL_ERROR_CODES.NETWORK_ERROR,
    status: 0,
    retryable: !isTls,
    causeCode,
    message: `Cannot reach Resend API: ${detail}`,
    hint: isTls
      ? "TLS certificate verification failed when connecting to Resend API. Check container CA certificates or proxy TLS settings."
      : "Check container DNS resolution, firewall rules, and outbound HTTPS (port 443) access to api.resend.com."
  };
}

function formatFixText(f) {
  if (typeof f === "string") return f;
  if (!f || typeof f !== "object") return String(f ?? "");
  const head = [f.title, f.file ? `(${f.file})` : null].filter(Boolean).join(" ");
  if (head && f.description) return `${head}: ${f.description}`;
  return head || f.description || JSON.stringify(f);
}

function formatFixHtml(f) {
  if (typeof f === "string") return escapeHtml(f);
  if (!f || typeof f !== "object") return escapeHtml(String(f ?? ""));
  const title = f.title ? `<strong>${escapeHtml(f.title)}</strong>` : "";
  const file = f.file ? ` <code>${escapeHtml(f.file)}</code>` : "";
  const desc = f.description ? `${title || file ? " — " : ""}${escapeHtml(f.description)}` : "";
  return `${title}${file}${desc}` || escapeHtml(JSON.stringify(f));
}

export function buildIdempotencyKey(incident, reason, from, recipients) {
  const safeId = String(incident?.id || "no-id").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  const digest = createHash("sha256")
    .update(`${safeId}|${String(reason || "")}|${String(from || "")}|${(recipients || []).join(",")}`)
    .digest("hex")
    .slice(0, 16);
  return `sbwk-${safeId}-${digest}`.slice(0, 128);
}

export function buildEmailPayload(incident, analysis, reason, { from, to, isTest = false }) {
  const severity = String(analysis?.severity || "unknown").toUpperCase();
  const method = String(incident?.method || "REQ").toUpperCase();
  const path = String(incident?.path || "/");
  const status = incident?.statusCode ?? "ERR";
  const incidentId = incident?.id || "n/a";
  const triggerReason = String(reason || "fault detected");
  const summary = analysis?.summary || "Application fault detected";
  const rootCause = analysis?.rootCause?.summary || "Under investigation";
  const confidence = typeof analysis?.confidence === "number" && Number.isFinite(analysis.confidence)
    ? `${Math.round(analysis.confidence * 100)}%`
    : null;
  const fixes = Array.isArray(analysis?.suggestedFixes) ? analysis.suggestedFixes : [];
  const deps = Array.isArray(analysis?.dependencyFindings) ? analysis.dependencyFindings : [];
  const rollback = analysis?.rollbackDecision;

  const subject = isTest
    ? sanitizeSubject(`[SBWK] Test Email Alert — Configuration Verified`)
    : sanitizeSubject(`[SBWK] ${severity} Fault: ${method} ${path} (HTTP ${status})`);

  const textLines = [
    isTest ? "SBWK Email Alert Operability Test" : "SBWK Fault Notification",
    `Severity: ${severity}${confidence ? ` (Confidence: ${confidence})` : ""}`,
    `Endpoint: ${method} ${path} (HTTP ${status})`,
    `Incident ID: ${incidentId}`,
    incident?.detectedAt ? `Detected At: ${incident.detectedAt}` : null,
    `Reason: ${triggerReason}`,
    `Summary: ${summary}`,
    `Root Cause: ${rootCause}`,
    deps.length ? `Dependencies: ${deps.map(d => `${d.service}=${d.status}`).join(", ")}` : null,
    fixes.length ? `Suggested Fixes:\n${fixes.map((f, i) => `  ${i + 1}. ${formatFixText(f)}`).join("\n")}` : null,
    rollback?.shouldRollback ? `Rollback Recommended: YES (target: ${rollback.targetCommitSha || "latest"}) — ${rollback.reason || ""}` : null
  ].filter(Boolean);

  const headingColor = isTest ? "#007a5a" : (severity === "CRITICAL" || severity === "HIGH" ? "#b91c1c" : "#b45309");
  const headingText = isTest ? "[SBWK] Email Alert Operability Test" : `[SBWK] ${escapeHtml(severity)} Fault Detected`;

  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:640px;margin:0 auto;padding:16px;border:1px solid #e5e7eb;border-radius:8px;">
      <h2 style="margin:0 0 12px;color:${headingColor};">${headingText}</h2>
      <p style="margin:4px 0;"><strong>Endpoint:</strong> <code>${escapeHtml(method)} ${escapeHtml(path)}</code> (HTTP ${escapeHtml(status)})</p>
      <p style="margin:4px 0;"><strong>Incident ID:</strong> <code>${escapeHtml(incidentId)}</code></p>
      ${confidence ? `<p style="margin:4px 0;"><strong>Confidence:</strong> ${escapeHtml(confidence)}</p>` : ""}
      <p style="margin:4px 0;"><strong>Trigger:</strong> ${escapeHtml(triggerReason)}</p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:12px 0;" />
      <p style="margin:4px 0;"><strong>Summary:</strong> ${escapeHtml(summary)}</p>
      <p style="margin:4px 0;"><strong>Root Cause:</strong> ${escapeHtml(rootCause)}</p>
      ${deps.length ? `<p style="margin:4px 0;"><strong>Dependencies:</strong> ${deps.map(d => `<code>${escapeHtml(d.service)}=${escapeHtml(d.status)}</code>`).join(", ")}</p>` : ""}
      ${fixes.length ? `<p style="margin:8px 0 4px;"><strong>Suggested Fixes:</strong></p><ul>${fixes.map(f => `<li>${formatFixHtml(f)}</li>`).join("")}</ul>` : ""}
      ${rollback?.shouldRollback ? `<p style="margin:12px 0;padding:8px 12px;background:#fef2f2;border-left:4px solid #dc2626;"><strong>Rollback Recommended:</strong> ${escapeHtml(rollback.reason || "See agent analysis")} (target: <code>${escapeHtml(rollback.targetCommitSha || "previous")}</code>)</p>` : ""}
    </div>
  `.trim();

  return { from, to, subject, text: textLines.join("\n"), html };
}

function normalizeOptions(fetchOrOptions) {
  if (typeof fetchOrOptions === "function") return { fetchImpl: fetchOrOptions };
  if (fetchOrOptions && typeof fetchOrOptions === "object") return fetchOrOptions;
  return {};
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function recordEmailTelemetry(entry) {
  telemetry.email.lastAttempt = entry;
  if (entry.sent) {
    telemetry.email.sent += 1;
    telemetry.email.lastSuccessAt = entry.at;
  } else if (entry.code === EMAIL_ERROR_CODES.NOT_CONFIGURED) {
    telemetry.email.skipped += 1;
  } else {
    telemetry.email.failed += 1;
    telemetry.email.lastFailureAt = entry.at;
  }
}

/**
 * Send a fault alert email via Resend's REST API.
 * NEVER throws. Always returns a structured delivery result with machine-readable
 * error classification, actionable hint, retry count, and latency.
 */
export async function sendResendEmail(incident, analysis, reason, fetchOrOptions = globalThis.fetch) {
  const opts = normalizeOptions(fetchOrOptions);
  const cfg = opts.config || defaultConfig;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const sleep = opts.sleep || defaultSleep;
  const started = Date.now();
  const at = new Date().toISOString();

  const check = validateMailConfig(cfg);

  if (check.state === "not_configured") {
    return {
      attempted: false,
      sent: false,
      code: EMAIL_ERROR_CODES.NOT_CONFIGURED,
      reason: "resend not configured"
    };
  }

  if (check.state === "misconfigured") {
    const primary = check.errors[0];
    logEvent("error", "resend_email_misconfigured", {
      incidentId: incident?.id || null,
      code: primary.code,
      field: primary.field,
      error: primary.message,
      hint: primary.hint
    });
    const res = {
      attempted: false,
      sent: false,
      code: primary.code,
      error: primary.message,
      hint: primary.hint,
      errors: check.errors,
      retryable: false,
      attempts: 0,
      latencyMs: Date.now() - started
    };
    recordEmailTelemetry({
      at, sent: false, attempted: false, code: res.code, error: res.error, hint: res.hint,
      incidentId: incident?.id || null, attempts: 0, latencyMs: res.latencyMs
    });
    return res;
  }

  if (typeof fetchImpl !== "function") {
    const res = {
      attempted: false,
      sent: false,
      code: EMAIL_ERROR_CODES.UNEXPECTED_ERROR,
      error: "No fetch implementation available in this Node.js runtime",
      hint: "Run agent-core on Node.js >= 20.",
      retryable: false,
      attempts: 0,
      latencyMs: Date.now() - started
    };
    recordEmailTelemetry({ at, sent: false, attempted: false, code: res.code, error: res.error, incidentId: incident?.id || null });
    return res;
  }

  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) ? Math.max(50, Number(opts.timeoutMs)) : check.timeoutMs;
  const maxRetries = Number.isFinite(Number(opts.maxRetries)) ? Math.max(0, Math.min(5, Math.round(Number(opts.maxRetries)))) : check.maxRetries;
  const retryBaseMs = Number.isFinite(Number(opts.retryBaseMs)) ? Math.max(0, Number(opts.retryBaseMs)) : DEFAULT_RETRY_BASE_MS;
  const maxAttempts = 1 + maxRetries;

  const payload = buildEmailPayload(incident, analysis, reason, {
    from: check.from,
    to: check.recipients,
    isTest: Boolean(opts.isTest)
  });
  const idempotencyKey = typeof opts.idempotencyKey === "string" && opts.idempotencyKey.trim()
    ? opts.idempotencyKey.trim().replace(/[\r\n\x00-\x1f\x7f]/g, "").slice(0, 256)
    : buildIdempotencyKey(incident, reason, check.from, check.recipients);

  const url = `${check.apiBaseUrl}/emails`;
  const headers = {
    "Authorization": `Bearer ${check._apiKey}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": USER_AGENT,
    "Idempotency-Key": idempotencyKey
  };
  const bodyJson = JSON.stringify(payload);

  let lastFailure = null;
  let attemptsUsed = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptsUsed = attempt;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers,
        body: bodyJson,
        signal: controller.signal
      });

      const { text, json, parseError } = await readResponseBody(res);

      if (res.ok) {
        const emailId = typeof json?.id === "string" && json.id.trim() ? json.id.trim() : null;
        if (parseError || !json || typeof json !== "object" || !emailId) {
          lastFailure = {
            code: EMAIL_ERROR_CODES.INVALID_RESPONSE,
            status: res.status,
            retryable: false,
            error: "Resend returned HTTP 2xx without a valid JSON email id (check proxy or RESEND_API_BASE_URL).",
            hint: `Confirm ${check.apiBaseUrl} points to Resend's API and is not intercepted by a proxy.`,
            providerError: text.slice(0, 200) || undefined
          };
          break;
        }

        const latencyMs = Date.now() - started;
        logEvent("info", "resend_email_sent", {
          incidentId: incident?.id || null,
          emailId,
          from: check.from,
          recipientsCount: check.recipients.length,
          attempts: attempt,
          latencyMs,
          isTest: Boolean(opts.isTest)
        });
        recordEmailTelemetry({
          at, sent: true, attempted: true, id: emailId, status: res.status,
          code: null, error: null, hint: null,
          incidentId: incident?.id || null, recipientsCount: check.recipients.length,
          attempts: attempt, latencyMs
        });
        return {
          attempted: true,
          sent: true,
          id: emailId,
          status: res.status,
          from: check.from,
          to: check.recipients,
          attempts: attempt,
          latencyMs,
          idempotencyKey
        };
      }

      const classified = classifyResendHttpError(res.status, json, text, res.headers, check._apiKey);
      lastFailure = {
        code: classified.code,
        status: res.status,
        retryable: classified.retryable,
        error: classified.message,
        hint: classified.hint,
        providerName: classified.providerName,
        providerError: classified.providerError,
        retryAfterMs: classified.retryAfterMs
      };
    } catch (err) {
      const classified = classifyNetworkError(err, timeoutMs);
      lastFailure = {
        code: classified.code,
        status: 0,
        retryable: classified.retryable,
        error: classified.message,
        hint: classified.hint,
        causeCode: classified.causeCode
      };
    } finally {
      clearTimeout(timer);
    }

    if (lastFailure.retryable && attempt < maxAttempts) {
      const backoff = retryBaseMs > 0 ? Math.min(retryBaseMs * (2 ** (attempt - 1)) + Math.floor(Math.random() * 100), MAX_RETRY_DELAY_MS) : 0;
      const delayMs = lastFailure.retryAfterMs ?? backoff;
      logEvent("warn", "resend_email_retry", {
        incidentId: incident?.id || null,
        attempt,
        maxAttempts,
        code: lastFailure.code,
        status: lastFailure.status,
        delayMs,
        error: lastFailure.error
      });
      if (delayMs > 0) await sleep(delayMs);
      continue;
    }

    break;
  }

  const latencyMs = Date.now() - started;
  logEvent("error", "resend_email_failed", {
    incidentId: incident?.id || null,
    code: lastFailure?.code || EMAIL_ERROR_CODES.UNEXPECTED_ERROR,
    status: lastFailure?.status ?? 0,
    retryable: Boolean(lastFailure?.retryable),
    attempts: attemptsUsed,
    latencyMs,
    from: check.from,
    recipientsCount: check.recipients.length,
    error: lastFailure?.error || "Unknown email error",
    hint: lastFailure?.hint
  });

  const out = {
    attempted: true,
    sent: false,
    status: lastFailure?.status ?? 0,
    code: lastFailure?.code || EMAIL_ERROR_CODES.UNEXPECTED_ERROR,
    error: lastFailure?.error || "Failed to send email via Resend",
    hint: lastFailure?.hint,
    ...(lastFailure?.providerName ? { providerName: lastFailure.providerName } : {}),
    ...(lastFailure?.providerError ? { providerError: lastFailure.providerError } : {}),
    ...(lastFailure?.causeCode ? { causeCode: lastFailure.causeCode } : {}),
    retryable: Boolean(lastFailure?.retryable),
    attempts: attemptsUsed,
    latencyMs,
    from: check.from,
    to: check.recipients
  };

  recordEmailTelemetry({
    at, sent: false, attempted: true, id: null, status: out.status,
    code: out.code, error: out.error, hint: out.hint,
    incidentId: incident?.id || null, recipientsCount: check.recipients.length,
    attempts: out.attempts, latencyMs
  });
  return out;
}

/**
 * Verify Resend configuration AND probe the Resend API key live (without sending an email).
 * Works with BOTH full-access API keys (also verifies sender domain status) and
 * least-privilege sending-only API keys (which Resend marks with 401 restricted_api_key on /domains).
 * NEVER throws.
 */
export async function verifyResendConfig(cfg = defaultConfig, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const started = Date.now();
  const check = validateMailConfig(cfg);
  const safeCheck = redactValidation(check);

  if (check.state === "not_configured") {
    return {
      ok: false,
      configured: false,
      valid: false,
      keyValid: null,
      code: EMAIL_ERROR_CODES.NOT_CONFIGURED,
      error: "Resend email notifications are not configured (set RESEND_API_KEY and DEVELOPER_EMAIL).",
      hint: "Set RESEND_API_KEY and DEVELOPER_EMAIL in .env or in the Control Plane Config tab.",
      config: safeCheck,
      latencyMs: Date.now() - started
    };
  }

  if (check.state === "misconfigured") {
    const primary = check.errors[0];
    return {
      ok: false,
      configured: check.configured,
      valid: false,
      keyValid: primary.code === EMAIL_ERROR_CODES.INVALID_API_KEY || primary.code === EMAIL_ERROR_CODES.MISSING_API_KEY ? false : null,
      code: primary.code,
      error: primary.message,
      hint: primary.hint,
      errors: check.errors,
      warnings: check.warnings,
      config: safeCheck,
      latencyMs: Date.now() - started
    };
  }

  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.max(50, Number(options.timeoutMs)) : check.timeoutMs;
  const url = `${check.apiBaseUrl}/domains`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${check._apiKey}`,
        "Accept": "application/json",
        "User-Agent": USER_AGENT
      },
      signal: controller.signal
    });
    const { text, json, parseError } = await readResponseBody(res);
    const latencyMs = Date.now() - started;

    // Case 1: Full-access key -> 200 OK with domains list
    if (res.ok) {
      if (parseError || !json || typeof json !== "object") {
        return {
          ok: false,
          configured: true,
          valid: false,
          keyValid: null,
          status: res.status,
          code: EMAIL_ERROR_CODES.INVALID_RESPONSE,
          error: "Resend /domains returned HTTP 2xx with non-JSON body.",
          hint: `Confirm ${check.apiBaseUrl} points to Resend's API.`,
          config: safeCheck,
          latencyMs
        };
      }

      if (check.isSandboxFrom) {
        return {
          ok: true,
          configured: true,
          valid: true,
          keyValid: true,
          keyAccess: "full",
          domainVerified: null,
          sandbox: true,
          status: res.status,
          message: "Resend API key verified (full access). Using sandbox sender onboarding@resend.dev.",
          warnings: check.warnings,
          config: safeCheck,
          latencyMs
        };
      }

      const domains = Array.isArray(json.data) ? json.data : [];
      const match = domains.find(d => typeof d?.name === "string" && d.name.toLowerCase() === check.fromDomain);
      if (!match) {
        return {
          ok: false,
          configured: true,
          valid: false,
          keyValid: true,
          keyAccess: "full",
          domainVerified: false,
          domainStatus: "not_found",
          status: res.status,
          code: EMAIL_ERROR_CODES.DOMAIN_NOT_VERIFIED,
          error: `Resend API key is valid, but sender domain '${check.fromDomain}' is not registered in your Resend account.`,
          hint: "Add and verify this domain at https://resend.com/domains, or switch RESEND_FROM_EMAIL to onboarding@resend.dev for sandbox testing.",
          warnings: check.warnings,
          config: safeCheck,
          latencyMs
        };
      }

      if (String(match.status || "").toLowerCase() !== "verified") {
        return {
          ok: false,
          configured: true,
          valid: false,
          keyValid: true,
          keyAccess: "full",
          domainVerified: false,
          domainStatus: match.status || "unknown",
          status: res.status,
          code: EMAIL_ERROR_CODES.DOMAIN_NOT_VERIFIED,
          error: `Resend API key is valid, but sender domain '${check.fromDomain}' has status '${match.status || "unverified"}'.`,
          hint: "Complete DNS verification for this domain at https://resend.com/domains before sending alerts from it.",
          warnings: check.warnings,
          config: safeCheck,
          latencyMs
        };
      }

      return {
        ok: true,
        configured: true,
        valid: true,
        keyValid: true,
        keyAccess: "full",
        domainVerified: true,
        domainStatus: "verified",
        sandbox: false,
        status: res.status,
        message: `Resend API key and sender domain '${check.fromDomain}' verified.`,
        warnings: check.warnings,
        config: safeCheck,
        latencyMs
      };
    }

    // Case 2: Sending-only API key -> Resend authenticates the key, then returns 401 restricted_api_key
    const classified = classifyResendHttpError(res.status, json, text, res.headers, check._apiKey);
    if (res.status === 401 && classified.code === EMAIL_ERROR_CODES.RESTRICTED_API_KEY) {
      return {
        ok: true,
        configured: true,
        valid: true,
        keyValid: true,
        keyAccess: "sending_only",
        domainVerified: null,
        sandbox: check.isSandboxFrom,
        status: res.status,
        message: "Resend API key verified (sending-only access — recommended least-privilege scope).",
        warnings: [
          ...check.warnings,
          {
            code: "sending_only_key",
            field: "RESEND_API_KEY",
            message: "Key is scoped to sending only, so domain verification status cannot be queried automatically. Use 'Send test email' to confirm end-to-end delivery."
          }
        ],
        config: safeCheck,
        latencyMs
      };
    }

    // Case 3: Invalid key, rate limit, provider error, etc.
    return {
      ok: false,
      configured: true,
      valid: false,
      keyValid: classified.code === EMAIL_ERROR_CODES.INVALID_API_KEY ? false : null,
      status: res.status,
      code: classified.code,
      error: classified.message,
      hint: classified.hint,
      providerName: classified.providerName,
      providerError: classified.providerError,
      retryable: classified.retryable,
      config: safeCheck,
      latencyMs
    };
  } catch (err) {
    const classified = classifyNetworkError(err, timeoutMs);
    return {
      ok: false,
      configured: true,
      valid: false,
      keyValid: null,
      status: 0,
      code: classified.code,
      error: classified.message,
      hint: classified.hint,
      causeCode: classified.causeCode,
      retryable: classified.retryable,
      config: safeCheck,
      latencyMs: Date.now() - started
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send a real test alert email through the production sendResendEmail path.
 * Confirms end-to-end operability (API key + sender domain + recipient delivery).
 */
export async function sendTestEmail(cfg = defaultConfig, options = {}) {
  const testId = `test-mail-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const incident = {
    id: testId,
    requestId: testId,
    method: "POST",
    path: "/notifications/test",
    statusCode: 200,
    detectedAt: now,
    category: "operability_test",
    reason: "Manual test email requested"
  };
  const analysis = {
    severity: "low",
    confidence: 1,
    summary: "SBWK email notification pipeline operability check succeeded.",
    rootCause: { summary: "No fault occurred — this is a manual test email sent from SBWK agent-core." },
    suggestedFixes: [{ title: "No action required", description: "Fault alerts will arrive at this address when incidents occur." }],
    dependencyFindings: []
  };
  return sendResendEmail(incident, analysis, options.reason || "manual operability test", {
    ...options,
    config: cfg,
    isTest: true
  });
}

function redactValidation(check) {
  const { _apiKey, ...safe } = check;
  return safe;
}

/** Public, secret-free notification status for GET /config and GET /notifications/status. */
export function getNotificationStatus(cfg = defaultConfig) {
  const safe = redactValidation(validateMailConfig(cfg));
  return {
    ...safe,
    stats: {
      sent: telemetry.email.sent,
      failed: telemetry.email.failed,
      skipped: telemetry.email.skipped,
      lastSuccessAt: telemetry.email.lastSuccessAt,
      lastFailureAt: telemetry.email.lastFailureAt
    },
    lastEmailAttempt: telemetry.email.lastAttempt,
    webhook: {
      configured: safe.webhookConfigured,
      sent: telemetry.webhook.sent,
      failed: telemetry.webhook.failed,
      lastAttempt: telemetry.webhook.lastAttempt
    }
  };
}

async function sendWebhookNotification(incident, analysis, reason, cfg, fetchImpl) {
  const rawUrl = String(cfg.NOTIFICATION_WEBHOOK_URL || "").trim();
  const started = Date.now();
  const at = new Date().toISOString();

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error(`Unsupported webhook protocol: ${parsedUrl.protocol}`);
    }
  } catch (e) {
    const out = { attempted: false, sent: false, status: 0, code: "invalid_webhook_url", error: e.message || "Invalid NOTIFICATION_WEBHOOK_URL", latencyMs: 0 };
    telemetry.webhook.failed += 1;
    telemetry.webhook.lastAttempt = { at, ...out };
    logEvent("error", "webhook_notification_failed", { incidentId: incident?.id || null, error: out.error });
    return out;
  }

  const severity = String(analysis?.severity || "unknown").toUpperCase();
  const method = incident?.method || "REQ";
  const path = incident?.path || "/";
  const statusCode = incident?.statusCode ?? "ERR";
  const summary = analysis?.summary || "Application fault detected";
  const rootCauseSummary = analysis?.rootCause?.summary || "Under investigation";
  const text = `[SBWK] Engineer attention needed — ${severity} ${method} ${path} (HTTP ${statusCode}). ${summary} Root cause: ${rootCauseSummary}. Reason: ${reason}. Incident ${incident?.id || "n/a"}.`;

  const timeoutMs = Number.isFinite(Number(cfg.REQUEST_TIMEOUT_MS)) && Number(cfg.REQUEST_TIMEOUT_MS) >= 100
    ? Number(cfg.REQUEST_TIMEOUT_MS)
    : 5000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(parsedUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({
        text,
        incidentId: incident?.id,
        severity: analysis?.severity || "unknown",
        summary,
        rootCause: analysis?.rootCause || { summary: rootCauseSummary },
        suggestedFixes: Array.isArray(analysis?.suggestedFixes) ? analysis.suggestedFixes : [],
        reason
      }),
      signal: controller.signal
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const { text: bodyText } = await readResponseBody(res);
      const out = {
        attempted: true,
        sent: false,
        status: res.status,
        code: "webhook_http_error",
        error: `Webhook returned HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 160)}` : ""}`,
        latencyMs
      };
      telemetry.webhook.failed += 1;
      telemetry.webhook.lastAttempt = { at, ...out };
      logEvent("error", "webhook_notification_failed", { incidentId: incident?.id || null, status: res.status, error: out.error });
      return out;
    }
    const out = { attempted: true, sent: true, status: res.status, latencyMs };
    telemetry.webhook.sent += 1;
    telemetry.webhook.lastAttempt = { at, ...out };
    return out;
  } catch (err) {
    const latencyMs = Date.now() - started;
    const isTimeout = err?.name === "AbortError" || err?.name === "TimeoutError";
    const out = {
      attempted: true,
      sent: false,
      status: 0,
      code: isTimeout ? "webhook_timeout" : "webhook_network_error",
      error: isTimeout ? `Webhook timed out after ${timeoutMs}ms` : (err?.cause?.message || err?.message || String(err)),
      latencyMs
    };
    telemetry.webhook.failed += 1;
    telemetry.webhook.lastAttempt = { at, ...out };
    logEvent("error", "webhook_notification_failed", { incidentId: incident?.id || null, code: out.code, error: out.error });
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Notify the developer team across all configured channels (always logs; optionally
 * posts to NOTIFICATION_WEBHOOK_URL and/or sends email via Resend.com).
 * NEVER throws.
 */
export async function notifyEngineer(incident, analysis, reason, fetchOrOptions = globalThis.fetch) {
  const opts = normalizeOptions(fetchOrOptions);
  const cfg = opts.config || defaultConfig;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const at = new Date().toISOString();

  const hasWebhook = Boolean(cfg.NOTIFICATION_WEBHOOK_URL && String(cfg.NOTIFICATION_WEBHOOK_URL).trim());
  const mailCheck = validateMailConfig(cfg);
  const mailActive = mailCheck.state !== "not_configured";

  const channels = ["log"];
  let webhookOk = true;
  let resendOk = true;
  let webhookRes;
  let emailRes;
  const errors = [];

  if (hasWebhook) {
    webhookRes = await sendWebhookNotification(incident, analysis, reason, cfg, fetchImpl);
    webhookOk = webhookRes.sent;
    if (webhookOk) channels.push("webhook");
    else errors.push({ channel: "webhook", code: webhookRes.code, message: webhookRes.error });
  }

  if (mailActive) {
    emailRes = await sendResendEmail(incident, analysis, reason, { ...opts, config: cfg, fetchImpl });
    resendOk = emailRes.sent;
    if (resendOk) channels.push("resend");
    else {
      errors.push({
        channel: "resend",
        code: emailRes.code,
        message: emailRes.error || emailRes.reason || "Email delivery failed",
        ...(emailRes.hint ? { hint: emailRes.hint } : {})
      });
    }
  }

  const channel = channels.join("+");
  const sent = (!hasWebhook || webhookOk) && (!mailActive || resendOk);

  logEvent(sent ? "warn" : "error", "engineer_notification", {
    timestamp: at,
    incidentId: incident?.id || null,
    severity: analysis?.severity || "unknown",
    reason,
    summary: analysis?.summary || "Application fault detected",
    channel,
    sent,
    ...(emailRes ? { emailStatus: emailRes.sent ? "sent" : emailRes.code, emailId: emailRes.id || undefined } : {}),
    ...(errors.length ? { errors } : {})
  });

  return {
    sent,
    channel,
    reason,
    at,
    ...(webhookRes ? { webhook: webhookRes } : {}),
    ...(emailRes ? { email: emailRes } : {}),
    ...(errors.length ? { errors } : {})
  };
}
