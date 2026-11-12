// Real network checks used by the onboarding UI. No mocked setTimeouts.
import dns from "node:dns/promises";
import { config } from "./config.mjs";

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(t); }
}

/**
 * Real reachability check.
 * - http(s): performs an actual request; ANY HTTP response (even 401/404) means reachable.
 * - other schemes (mongodb+srv, postgres, redis…): resolves DNS for the host. A full
 *   protocol handshake would require a driver, so this is a DNS-level reachability probe.
 */
export async function checkReachability(rawUrl, { token, timeoutMs = config.REQUEST_TIMEOUT_MS } = {}) {
  const started = Date.now();
  let url;
  try { url = new URL(rawUrl); } catch { return { ok: false, reachable: false, error: "Invalid URL" }; }

  if (url.protocol === "http:" || url.protocol === "https:") {
    try {
      const res = await fetchWithTimeout(url.toString(), { method: "GET", headers: token ? { Authorization: `Bearer ${token}` } : {} }, timeoutMs);
      return { ok: true, reachable: true, method: "http", status: res.status, latencyMs: Date.now() - started };
    } catch (e) {
      return { ok: false, reachable: false, method: "http", error: e.name === "AbortError" ? "Timed out" : (e.cause?.code || e.message || "Unreachable"), latencyMs: Date.now() - started };
    }
  }

  // Non-HTTP: DNS-level probe.
  try {
    const host = url.hostname;
    if (!host) return { ok: false, reachable: false, error: "No host in URL" };
    const records = await dns.lookup(host);
    return { ok: true, reachable: true, method: "dns", address: records.address, latencyMs: Date.now() - started, note: `${url.protocol} reachability verified via DNS (protocol handshake not performed)` };
  } catch (e) {
    return { ok: false, reachable: false, method: "dns", error: e.code || e.message || "DNS lookup failed", latencyMs: Date.now() - started };
  }
}

/** Parse owner/repo from a GitHub URL, git remote, or "owner/repo" shorthand. */
export function parseRepoUrl(input) {
  if (!input || typeof input !== "string") return null;
  const s = input.trim().replace(/\.git$/, "");
  let m = s.match(/github\.com[/:]([^/\s]+)\/([^/\s]+)$/i);
  if (m) return { owner: m[1], repo: m[2] };
  m = s.match(/^([^/\s:@]+)\/([^/\s:@]+)$/);
  if (m) return { owner: m[1], repo: m[2] };
  return null;
}

/** Fetch real repository metadata + the last 5 commits from the GitHub API. */
export async function fetchGitHubRepo(repoUrl, token, { timeoutMs = config.REQUEST_TIMEOUT_MS } = {}) {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) throw new Error("Could not parse repository URL (expected https://github.com/owner/repo)");
  const { owner, repo } = parsed;
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "sbwk-control-plane", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const base = `${config.GITHUB_API_BASE}/repos/${owner}/${repo}`;

  const metaRes = await fetchWithTimeout(base, { headers }, timeoutMs);
  if (metaRes.status === 404) throw new Error("Repository not found, or the token lacks access");
  if (metaRes.status === 401) throw new Error("Invalid or expired access token");
  if (metaRes.status === 403) throw new Error("GitHub API forbidden or rate-limited");
  if (!metaRes.ok) throw new Error(`GitHub returned HTTP ${metaRes.status}`);
  const meta = await metaRes.json();

  const commitsRes = await fetchWithTimeout(`${base}/commits?per_page=5`, { headers }, timeoutMs);
  if (!commitsRes.ok) throw new Error(`Could not read commits (HTTP ${commitsRes.status})`);
  const rawCommits = await commitsRes.json();
  const commits = (Array.isArray(rawCommits) ? rawCommits : []).slice(0, 5).map(c => ({
    sha: c.sha,
    message: c.commit?.message || "",
    author: c.author?.login || c.commit?.author?.name || "unknown",
    date: c.commit?.author?.date || null,
    url: c.html_url || null
  }));

  return { fullName: meta.full_name, repoUrl: meta.html_url || repoUrl, defaultBranch: meta.default_branch, private: meta.private, description: meta.description || "", commits };
}
