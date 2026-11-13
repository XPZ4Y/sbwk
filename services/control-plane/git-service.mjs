// Zero-dependency GitHub REST API helper for Git Branches tab, last 4 diffs, and rollback.

export function parseGitHubRepo(repoUrl) {
  if (!repoUrl || typeof repoUrl !== "string") return null;
  const cleaned = repoUrl.trim().replace(/\.git$/, "");
  const httpsMatch = cleaned.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  const sshMatch = cleaned.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
  const shortMatch = cleaned.match(/^([^/]+)\/([^/]+)$/);
  if (shortMatch) return { owner: shortMatch[1], repo: shortMatch[2] };
  return null;
}

function ghHeaders(token) {
  return {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "sbwk-control-plane",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

export async function fetchGitStatus(repoUrl, token, fetchImpl = globalThis.fetch) {
  const parsed = parseGitHubRepo(repoUrl);
  if (!parsed || !token) {
    return { configured: false, error: "GitHub repository URL and PAT are required." };
  }
  const { owner, repo } = parsed;
  const headers = ghHeaders(token);
  const base = `https://api.github.com/repos/${owner}/${repo}`;

  const [repoRes, branchesRes, commitsRes] = await Promise.all([
    fetchImpl(base, { headers }),
    fetchImpl(`${base}/branches?per_page=20`, { headers }),
    fetchImpl(`${base}/commits?per_page=4`, { headers })
  ]);

  if (!repoRes.ok) {
    const msg = await repoRes.text().catch(() => "");
    return { configured: true, ok: false, error: `GitHub API ${repoRes.status}: ${msg.slice(0, 180)}` };
  }

  const repoData = await repoRes.json();
  const branchesData = branchesRes.ok ? await branchesRes.json() : [];
  const commitsData = commitsRes.ok ? await commitsRes.json() : [];

  const diffs = await Promise.all(
    (Array.isArray(commitsData) ? commitsData.slice(0, 4) : []).map(async (c) => {
      const detailRes = await fetchImpl(`${base}/commits/${c.sha}`, { headers });
      const detail = detailRes.ok ? await detailRes.json() : null;
      return {
        sha: c.sha,
        shortSha: c.sha.slice(0, 7),
        message: c.commit?.message?.split("\n")[0] || "",
        author: c.commit?.author?.name || c.author?.login || "unknown",
        date: c.commit?.author?.date || null,
        url: c.html_url || null,
        files: (detail?.files || []).slice(0, 12).map(f => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch ? String(f.patch).slice(0, 2000) : ""
        }))
      };
    })
  );

  return {
    configured: true,
    ok: true,
    repo: {
      owner,
      repo,
      fullName: `${owner}/${repo}`,
      defaultBranch: repoData.default_branch || "main",
      htmlUrl: repoData.html_url
    },
    branches: (Array.isArray(branchesData) ? branchesData : []).map(b => ({
      name: b.name,
      sha: b.commit?.sha?.slice(0, 7) || "",
      fullSha: b.commit?.sha || "",
      protected: Boolean(b.protected)
    })),
    diffs
  };
}

export async function rollbackToParent(repoUrl, token, targetSha, branch = "main", fetchImpl = globalThis.fetch) {
  const parsed = parseGitHubRepo(repoUrl);
  if (!parsed || !token || !targetSha) {
    return { ok: false, error: "repoUrl, token, and targetSha are required." };
  }
  const { owner, repo } = parsed;
  const headers = ghHeaders(token);
  const base = `https://api.github.com/repos/${owner}/${repo}`;

  const commitRes = await fetchImpl(`${base}/commits/${targetSha}`, { headers });
  if (!commitRes.ok) {
    return { ok: false, error: `Failed to fetch commit ${targetSha}: HTTP ${commitRes.status}` };
  }
  const commitData = await commitRes.json();
  const parentSha = commitData.parents?.[0]?.sha;
  if (!parentSha) {
    return { ok: false, error: `Commit ${targetSha} has no parent commit to roll back to.` };
  }

  const refRes = await fetchImpl(`${base}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ sha: parentSha, force: true })
  });

  if (!refRes.ok) {
    const errText = await refRes.text().catch(() => "");
    return { ok: false, error: `Failed to update branch ${branch}: HTTP ${refRes.status} ${errText.slice(0, 180)}` };
  }

  return {
    ok: true,
    branch,
    rolledBackFrom: targetSha.slice(0, 7),
    rolledBackTo: parentSha.slice(0, 7),
    parentSha
  };
}
