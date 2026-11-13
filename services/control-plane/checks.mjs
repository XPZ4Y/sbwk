// Real reachability checks and GitHub metadata. Outbound targets pass through the
// SSRF guard. Redirects are not followed, so a 3xx from a target can't bounce the
// probe to an internal address.
import dns from "node:dns/promises";
import { config } from "./config.mjs";
import { assertAllowedHost } from "./ssrf.mjs";
import { isLoopbackHost } from "./external.mjs";

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal, redirect: "manual" }); }
  finally { clearTimeout(t); }
}

/**
 * - http(s): any HTTP response means reachable, including 401/403. Use the
 *   `status` field to judge auth; reachability alone does not prove a token works.
 * - Tokens are refused over plaintext http to non-loopback hosts.
 * - Other schemes: DNS-only. No protocol handshake is performed, and the result says so.
 */
export async function checkReachability(rawUrl, {
  token,
  timeoutMs = config.REQUEST_TIMEOUT_MS,
  blockPrivate = config.BLOCK_PRIVATE_NETWORKS
} = {}) {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  let url;
  try { url = new URL(rawUrl); } catch { return { ok: false, reachable: false, error: "invalid URL", latencyMs: elapsed() }; }
  const isHttp = url.protocol === "http:" || url.protocol === "https:";
  const method = isHttp ? "http" : "dns";

  try { await assertAllowedHost(url.hostname, { block: blockPrivate }); }
  catch (e) { return { ok: false, reachable: false, method, error: e.message, latencyMs: elapsed() }; }

  if (isHttp) {
    if (token && url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
      return { ok: false, reachable: false, method, error: "refusing to send a token over plaintext http", latencyMs: elapsed() };
    }
    try {
      const res = await fetchWithTimeout(url.toString(), {
        method: "GET",
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      }, timeoutMs);
      await res.body?.cancel().catch(() => {});
      return { ok: true, reachable: true, method, status: res.status, latencyMs: elapsed() };
    } catch (e) {
      return {
        ok: false, reachable: false, method,
        error: e.name === "AbortError" ? "timed out" : (e.cause?.code || e.message || "unreachable"),
        latencyMs: elapsed()
      };
    }
  }

  try {
    const { address } = await dns.lookup(url.hostname);
    return {
      ok: true, reachable: true, method, address, latencyMs: elapsed(),
      note: `${url.protocol} checked by DNS only; no protocol handshake was performed`
    };
  } catch (e) {
    return { ok: false, reachable: false, method, error: e.code || e.message || "DNS lookup failed", latencyMs: elapsed() };
  }
}

/** owner/repo from a GitHub URL, a git remote, or the owner/repo shorthand. */
export function parseRepoUrl(input) {
  if (!input || typeof input !== "string") return null;
  const s = input.trim().replace(/\.git$/, "");
  let m = s.match(/github\.com[/:]([^/\s]+)\/([^/\s]+)$/i);
  if (m) return { owner: m[1], repo: m[2] };
  m = s.match(/^([^/\s:@]+)\/([^/\s:@]+)$/);
  if (m) return { owner: m[1], repo: m[2] };
  return null;
}

/** Repository metadata plus the last five commits, from the GitHub API. */
export async function fetchGitHubRepo(repoUrl, token, { timeoutMs = config.REQUEST_TIMEOUT_MS } = {}) {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) throw new Error("could not parse the repository URL (expected https://github.com/owner/repo)");
  const { owner, repo } = parsed;
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "sbwk-control-plane", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const base = `${config.GITHUB_API_BASE}/repos/${owner}/${repo}`;

  const metaRes = await fetchWithTimeout(base, { headers }, timeoutMs);
  if (metaRes.status === 404) throw new Error("repository not found, or the token has no access to it");
  if (metaRes.status === 401) throw new Error("the access token is invalid or expired");
  if (metaRes.status === 403) throw new Error("GitHub denied the request (forbidden or rate-limited)");
  if (!metaRes.ok) throw new Error(`GitHub returned HTTP ${metaRes.status}`);
  const meta = await metaRes.json();

  const commitsRes = await fetchWithTimeout(`${base}/commits?per_page=5`, { headers }, timeoutMs);
  if (!commitsRes.ok) throw new Error(`could not read commits (HTTP ${commitsRes.status})`);
  const raw = await commitsRes.json();
  const commits = (Array.isArray(raw) ? raw : []).slice(0, 5).map(c => ({
    sha: c.sha,
    message: c.commit?.message || "",
    author: c.author?.login || c.commit?.author?.name || "unknown",
    date: c.commit?.author?.date || null,
    url: c.html_url || null
  }));

  return {
    fullName: meta.full_name,
    repoUrl: meta.html_url || repoUrl,
    defaultBranch: meta.default_branch,
    private: meta.private,
    description: meta.description || "",
    commits
  };
}
