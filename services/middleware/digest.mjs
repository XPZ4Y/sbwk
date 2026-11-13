// Compact "log digest" of a buffered batch of bad requests (no dependencies).
//
// Why: the whole point of the two-stage gate is that Agent Core never receives
// a raw firehose. When the buffer wakes up we send ONE small, deterministic
// summary — counts by category/status, the noisiest paths, and a handful of
// samples — plus the raw incidents. Liquid d1 then answers a single yes/no
// question about the digest, so the cost of "nothing is wrong" stays flat no
// matter how many bad requests piled up.
//
// Everything here is pure so it is trivially unit-testable and the digest a
// routing decision was based on can always be reproduced from the incidents.

const SAMPLE_CHARS = 240;

const bump = (map, key) => { map[key] = (map[key] || 0) + 1; };

const truncate = (text, max = SAMPLE_CHARS) => {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/**
 * Build the digest sent to Agent Core alongside the raw incidents.
 *
 * @param {Array<object>} incidents normalized incidents (see detector.buildIncident)
 * @param {object} opts
 * @param {number} opts.samples    how many representative incidents to quote (default 5)
 * @param {number} opts.topPaths   how many paths to rank (default 5)
 * @param {number} opts.dropped    incidents the ring buffer had to evict (optional)
 * @param {number} opts.windowMs   the window the threshold was measured over (optional)
 * @returns {object} plain-JSON digest
 */
export function buildLogDigest(incidents = [], opts = {}) {
  const list = Array.isArray(incidents) ? incidents.filter(i => i && typeof i === "object") : [];
  const sampleCount = Math.max(0, Number.isFinite(opts.samples) ? opts.samples : 5);
  const topPathCount = Math.max(1, Number.isFinite(opts.topPaths) ? opts.topPaths : 5);

  const byCategory = {};
  const byStatus = {};
  const byMethod = {};
  const pathStats = new Map();
  let slowestMs = 0;

  for (const incident of list) {
    bump(byCategory, incident.category || "unknown");
    bump(byStatus, String(incident.statusCode ?? "unknown"));
    bump(byMethod, incident.method || "UNKNOWN");
    const path = incident.path || "unknown";
    const prev = pathStats.get(path) || { path, count: 0, statuses: new Map(), categories: new Map() };
    prev.count += 1;
    bump(prev.statuses, String(incident.statusCode ?? "unknown"));
    bump(prev.categories, incident.category || "unknown");
    pathStats.set(path, prev);
    const duration = Number(incident.durationMs);
    if (Number.isFinite(duration) && duration > slowestMs) slowestMs = duration;
  }

  const topPaths = [...pathStats.values()]
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    .slice(0, topPathCount)
    .map(p => ({
      path: p.path,
      count: p.count,
      statuses: Object.fromEntries(p.statuses),
      categories: Object.fromEntries(p.categories)
    }));

  const detectedAt = list.map(i => i.detectedAt).filter(Boolean).sort();
  const samples = list.slice(-sampleCount).map(i => ({
    method: i.method,
    path: i.path,
    statusCode: i.statusCode,
    category: i.category,
    reason: truncate(i.reason, 200),
    durationMs: i.durationMs,
    responseSample: i.responseSample === undefined ? undefined : truncate(i.responseSample),
    error: i.error === undefined ? undefined : truncate(i.error, 120)
  }));

  const digest = {
    count: list.length,
    byCategory,
    byStatus,
    byMethod,
    topPaths,
    slowestMs: Math.round(slowestMs * 100) / 100,
    samples
  };
  if (detectedAt.length) {
    digest.from = detectedAt[0];
    digest.to = detectedAt[detectedAt.length - 1];
  }
  if (Number.isFinite(opts.windowMs)) digest.windowMs = opts.windowMs;
  if (Number.isFinite(opts.dropped) && opts.dropped > 0) digest.dropped = opts.dropped;
  return digest;
}

/**
 * One-line, human-readable rendering of a digest. Used in logs and as the
 * fallback `state` text when a digest is missing, never for routing logic.
 */
export function describeDigest(digest = {}) {
  const cats = Object.entries(digest.byCategory || {}).map(([k, v]) => `${k}=${v}`).join(", ") || "none";
  const paths = (digest.topPaths || []).slice(0, 3).map(p => `${p.path} x${p.count}`).join(", ") || "none";
  return `${digest.count || 0} bad requests (${cats}); top paths: ${paths}`;
}
