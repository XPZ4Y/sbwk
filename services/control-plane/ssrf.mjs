// Outbound-target guard. The control plane fetches URLs that an operator types in,
// so with BLOCK_PRIVATE_NETWORKS=true it must not reach private, loopback or
// link-local addresses. Limitation: this resolves the name once before the request,
// so a DNS-rebinding attacker could still race it. Full protection needs the
// resolved IP pinned into the connection; that is a follow-up.
import dns from "node:dns/promises";
import net from "node:net";

export class TargetBlockedError extends Error {
  constructor(message) { super(message); this.name = "TargetBlockedError"; this.code = "TARGET_BLOCKED"; }
}

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127); // carrier-grade NAT
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::" || v === "::1") return true;
    if (v.startsWith("fc") || v.startsWith("fd")) return true;                       // fc00::/7
    if (/^fe[89ab]/.test(v)) return true;                                           // fe80::/10
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true; // not an address at all: treat as unsafe
}

export async function assertAllowedHost(hostname, { block }) {
  if (!block) return;
  if (!hostname) throw new TargetBlockedError("URL has no host");
  const literal = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(literal)) {
    if (isPrivateAddress(literal)) throw new TargetBlockedError(`${literal} is a private address`);
    return;
  }
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  const bad = records.find(r => isPrivateAddress(r.address));
  if (bad) throw new TargetBlockedError(`${hostname} resolves to private address ${bad.address}`);
}
