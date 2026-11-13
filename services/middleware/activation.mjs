// Dumb activation function for the lazy gate (pure, zero dependencies).
//
// The batch gate's wake condition used to be one number: "BATCH_MIN_BAD bad
// requests inside BATCH_WINDOW_MS". That is deliberately dumb, but it is also
// *uniform* — it wakes for five 404s exactly as readily as for the upstream
// dying, and it never says "this is obviously not something an LLM can help
// with".
//
// This file adds the two missing dumb rules, both pure and reviewable:
//
//   1. IMPULSE   — one severe-enough event should not wait for a pattern.
//                  Upgrade one bad request from buffered → flush on the spot
//                  when it is a 5xx with no body, an unreachable/timed-out
//                  upstream, a repeated failure on a path that keeps breaking,
//                  or a very slow response. No learning, no statistics.
//
//   2. TRIVIAL   — the things an LLM (or a human) cannot act on do not deserve
//                  a model call at all: 404s on random scanner paths, auth
//                  failures that are just clients not logging in, runaway
//                  favicon/robots noise. If a whole batch is trivial, the gate
//                  answers itself and Liquid is never called.
//
// Everything here is a handful of comparisons. That is the point: the expensive
// intelligence sits *behind* this function, and this function is the part you
// can read in one sitting and predict exactly.

export const TRIVIAL_REASONS = {
  scanner_path: "scanner/noise path (no application route)",
  client_auth: "client-side auth failure (bad or missing credentials)",
  not_found: "client requested a route that does not exist",
  bot_or_asset: "favicon/robots/asset probe"
};

/** Paths that never indicate an application defect. Matched as exact or prefix. */
const NOISE_PATHS = [
  "/favicon.ico", "/robots.txt", "/.env", "/.git", "/wp-admin", "/wp-login.php",
  "/xmlrpc.php", "/phpmyadmin", "/admin.php", "/.aws", "/.ssh", "/vendor/phpunit"
];

const NOISE_PREFIXES = [
  "/.env", "/.git", "/wp-", "/wordpress", "/phpmyadmin", "/cgi-bin", "/vendor/",
  "/.aws", "/.ssh", "/solr/", "/actuator/", "/boaform", "/hnap1", "/owa/", "/ecp/"
];

const isNoisePath = path => {
  const p = String(path || "").toLowerCase();
  if (!p) return false;
  return NOISE_PATHS.includes(p) || NOISE_PREFIXES.some(prefix => p.startsWith(prefix));
};

/**
 * Is this single incident severe enough to skip the "wait for a pattern" rule?
 * Pure: it only reads the incident and a precomputed `recurrence` number.
 *
 * @param {object} incident  as built by detector.buildIncident
 * @param {object} [opts]
 * @param {number} [opts.recurrence=0]       recent failures already seen on this path
 * @param {number} [opts.severeMs=5000]      a response this slow counts as severe
 * @param {boolean} [opts.severeStatuses=true]  treat 5xx / network failures as severe
 * @returns {{impulse: boolean, reasons: string[], score: number}}
 */
export function classifyImpulse(incident = {}, opts = {}) {
  const recurrence = Number(opts.recurrence) || 0;
  const severeMs = Number.isFinite(Number(opts.severeMs)) ? Number(opts.severeMs) : 5000;
  const severeStatuses = opts.severeStatuses !== false;
  const reasons = [];
  let score = 0;

  const category = String(incident.category || "");
  const status = Number(incident.statusCode);
  const duration = Number(incident.durationMs);
  const path = incident.path || "";

  if (severeStatuses && (category === "upstream_unreachable" || category === "timeout")) {
    reasons.push(category === "timeout" ? "upstream timed out" : "upstream unreachable");
    score += 4;
  }
  if (severeStatuses && Number.isFinite(status) && status >= 500) {
    reasons.push(`server error HTTP ${status}`);
    score += 2;
  }
  if (severeStatuses && Number.isFinite(duration) && duration >= severeMs) {
    reasons.push(`response took ${Math.round(duration)}ms (>= ${Math.round(severeMs)}ms)`);
    score += 2;
  }
  if (recurrence >= 1) {
    reasons.push(`repeated failure on ${path} (${recurrence + 1}x recently)`);
    score += 3;
  }

  // A "trivial" incident never self-activates, however often scanners hammer it:
  // repetition of noise is still noise.
  if (isNoisePath(path) && !reasons.some(r => r.startsWith("upstream"))) {
    const trivial = explainTrivial(incident, opts);
    if (trivial.trivial) return { impulse: false, reasons: [trivial.reason], score, suppressedByTrivial: true };
  }

  return { impulse: reasons.length > 0, reasons, score };
}

/**
 * Would a human or an LLM be able to act on this? If every incident in a batch
 * is trivial, the batch can be answered without a model call at all.
 *
 * Deliberately conservative: "trivial" needs a recognised no-op signature —
 * a 404/401/403 on a route we know exists is *not* automatically pointless, so
 * only scanner paths and asset probes are treated as unconditionally noise, and
 * client errors inside `/api/auth/*` are treated as client mistakes.
 *
 * @returns {{trivial: boolean, reason: string|null, code: string|null}}
 */
export function explainTrivial(incident = {}, opts = {}) {
  const status = Number(incident.statusCode);
  const path = incident.path || "";
  const category = String(incident.category || "");
  const ignoreClientErrors = opts.ignoreClientErrors !== false;

  // Infrastructure failures are never trivial: they are the whole point.
  if (category === "upstream_unreachable" || category === "timeout") return { trivial: false, reason: null, code: null };
  if (Number.isFinite(status) && status >= 500) return { trivial: false, reason: null, code: null };

  if (isNoisePath(path)) {
    // favicon/robots are browser/asset probes; everything else here is a scan.
    const asset = /favicon|robots/i.test(path);
    return { trivial: true, code: asset ? "bot_or_asset" : "scanner_path", reason: asset ? TRIVIAL_REASONS.bot_or_asset : TRIVIAL_REASONS.scanner_path };
  }

  if (!ignoreClientErrors) return { trivial: false, reason: null, code: null };

  if (status === 401 || status === 403) {
    return { trivial: true, code: "client_auth", reason: TRIVIAL_REASONS.client_auth };
  }
  if (status === 404) {
    return { trivial: true, code: "not_found", reason: TRIVIAL_REASONS.not_found };
  }

  return { trivial: false, reason: null, code: null };
}

/**
 * Classify a whole buffered batch. `reason` is the single dominant explanation:
 * one real incident among the noise still makes the batch worth looking at.
 *
 * @returns {{trivial: boolean, reason: string|null, code: string|null, real: number, trivialCount: number, byCode: object}}
 */
export function explainBatch(incidents = [], opts = {}) {
  const list = Array.isArray(incidents) ? incidents : [];
  const byCode = {};
  let trivialCount = 0;
  let firstReason = null;
  let firstCode = null;

  for (const incident of list) {
    const verdict = explainTrivial(incident, opts);
    if (!verdict.trivial) continue;
    trivialCount += 1;
    byCode[verdict.code] = (byCode[verdict.code] || 0) + 1;
    if (!firstReason) { firstReason = verdict.reason; firstCode = verdict.code; }
  }

  const real = list.length - trivialCount;
  if (list.length === 0) return { trivial: false, reason: null, code: null, real: 0, trivialCount: 0, byCode };
  return { trivial: real === 0, reason: firstReason, code: firstCode, real, trivialCount, byCode };
}
