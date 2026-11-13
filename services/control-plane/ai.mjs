// Control-plane <-> agent-core bridge for the AI settings (Liquid router + Groq prompts).
// The browser never sees the agent-core token: everything is proxied here.
import { config } from "./config.mjs";

const auth = { Authorization: `Bearer ${config.AGENT_CORE_TOKEN}` };

async function request(path, { method = "GET", body, timeoutMs } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs || config.REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.AGENT_CORE_URL}${path}`, {
      method,
      headers: { ...auth, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      redirect: "manual"
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      return { ok: false, status: res.status, error: data?.error?.message || data?.error || `agent-core HTTP ${res.status}`, data };
    }
    return { ok: true, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, error: e.name === "AbortError" ? "agent-core timeout" : (e.cause?.code || e.message || "agent-core unreachable") };
  } finally {
    clearTimeout(t);
  }
}

/** Current AI config as agent-core reports it (never includes API keys). */
export async function getAiConfig() {
  const r = await request("/config");
  if (!r.ok) return { ok: false, error: r.error, status: r.status };
  return { ok: true, config: r.data?.config || null };
}

/**
 * Persist prompt / router settings. Only whitelisted keys are forwarded, so the
 * browser cannot smuggle arbitrary config into agent-core.
 */
export async function saveAiConfig(input = {}) {
  const patch = {};
  if (input.llm && typeof input.llm === "object") {
    const llm = {};
    for (const k of ["profile", "systemPrompt", "userPromptTemplate", "model"]) {
      if (typeof input.llm[k] === "string") llm[k] = input.llm[k];
    }
    for (const k of ["temperature", "maxTokens"]) {
      if (typeof input.llm[k] === "number" && Number.isFinite(input.llm[k])) llm[k] = input.llm[k];
    }
    if (input.llm.reset === true) llm.reset = true;
    if (Object.keys(llm).length) patch.llm = llm;
  }
  if (input.liquid && typeof input.liquid === "object") {
    const liquid = {};
    for (const k of ["apiKey", "model", "baseUrl"]) {
      if (typeof input.liquid[k] === "string") liquid[k] = input.liquid[k];
    }
    if (typeof input.liquid.enabled === "boolean") liquid.enabled = input.liquid.enabled;
    if (input.liquid.routePolicy && typeof input.liquid.routePolicy === "object" && !Array.isArray(input.liquid.routePolicy)) {
      liquid.routePolicy = input.liquid.routePolicy;
    }
    if (Object.keys(liquid).length) patch.liquid = liquid;
  }
  if (typeof input.aiDebug === "boolean") patch.aiDebug = input.aiDebug;

  if (!Object.keys(patch).length) return { ok: false, status: 400, error: "nothing to update" };

  const r = await request("/config", { method: "POST", body: patch });
  if (!r.ok) return { ok: false, error: r.error, status: r.status };
  return { ok: true, config: r.data?.config || null };
}

/**
 * Run one synthetic incident end-to-end (Liquid -> Groq) so prompt changes can be
 * compared before trusting them. agent-core runs it in an isolated store: nothing
 * is persisted and no engineer notification is fired.
 */
export async function runPromptTest(incident = {}) {
  const r = await request("/incidents?test=true&wait=true", {
    method: "POST",
    body: incident && typeof incident === "object" ? incident : {},
    timeoutMs: 60000 // a live LLM with tool calls can take a while
  });
  if (!r.ok) return { ok: false, error: r.error, status: r.status };
  return { ok: true, incident: r.data?.incident || null };
}
