// Pure anomaly-detection helpers (no dependencies).

export function classifyStatus(statusCode, minStatus) {
  if (statusCode >= 500) return { detect: statusCode >= minStatus, category: "server_error", reason: `Upstream returned server error HTTP ${statusCode}` };
  if (statusCode >= 400) return { detect: statusCode >= minStatus, category: "client_error", reason: `Upstream returned client error HTTP ${statusCode}` };
  return { detect: false, category: "server_error", reason: "Normal response" };
}

export function categoryForUpstreamError(code) {
  return code === "TIMEOUT" ? "timeout" : "upstream_unreachable";
}

export class DispatchThrottle {
  constructor(cooldownMs) { this.cooldownMs = cooldownMs; this.last = new Map(); }
  static key(i) { return `${i.method} ${i.path} ${i.statusCode}`; }
  shouldDispatch(i, now = Date.now()) {
    const key = DispatchThrottle.key(i);
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < this.cooldownMs) return false;
    this.last.set(key, now);
    if (this.last.size > 1000) for (const [k, t] of this.last) if (now - t >= this.cooldownMs) this.last.delete(k);
    return true;
  }
}

export function buildIncident(input) {
  const idx = input.url.indexOf("?");
  const path = idx === -1 ? input.url : input.url.slice(0, idx);
  const query = idx === -1 ? "" : input.url.slice(idx + 1);
  return {
    id: input.id,
    requestId: input.requestId,
    source: "middleware",
    detectedAt: new Date().toISOString(),
    method: input.method,
    path,
    query: query || undefined,
    statusCode: input.statusCode,
    durationMs: Math.round(input.durationMs * 100) / 100,
    upstream: input.upstream,
    category: input.category,
    reason: input.reason,
    responseSample: input.responseSample || undefined,
    clientIp: input.clientIp,
    userAgent: input.userAgent,
    error: input.error
  };
}
