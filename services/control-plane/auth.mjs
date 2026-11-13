// Session-based auth for the control plane. Zero dependencies.
import crypto from "node:crypto";
import { config } from "./config.mjs";

const SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8 hours
const COOKIE_NAME = "sbwk_session";
const sessions = new Map(); // token -> { expiresAt, createdAt }

// Derive a scrypt hash of the configured password once at boot.
let passwordHash = null;
let passwordSalt = null;

export function initAuth() {
  const pw = config.CONTROL_PLANE_PASSWORD;
  if (!pw) {
    if (config.NODE_ENV === "production") {
      throw new Error("CONTROL_PLANE_PASSWORD must be set in production");
    }
    const generated = crypto.randomBytes(18).toString("base64url");
    console.error(`\n[control-plane] WARNING: CONTROL_PLANE_PASSWORD not set.`);
    console.error(`[control-plane] Generated development password: ${generated}\n`);
    process.env.CONTROL_PLANE_PASSWORD = generated;
  }
  passwordSalt = crypto.randomBytes(16);
  passwordHash = crypto.scryptSync(config.CONTROL_PLANE_PASSWORD, passwordSalt, 64);
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function verifyPassword(candidate) {
  if (!passwordHash || typeof candidate !== "string") return false;
  const h = crypto.scryptSync(candidate, passwordSalt, 64);
  return safeEqual(h, passwordHash);
}

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createSession() {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  sessions.set(token, { createdAt: now, expiresAt: now + SESSION_TTL_MS });
  return token;
}

export function destroySession(token) {
  if (token) sessions.delete(token);
}

export function sessionFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expiresAt < Date.now()) { sessions.delete(token); return null; }
  return { token, ...s };
}

export function sessionCookie(token, { secure }) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const parts = [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

// Periodic sweep so dead sessions don't accumulate.
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.expiresAt < now) sessions.delete(t);
}, 60_000).unref();
