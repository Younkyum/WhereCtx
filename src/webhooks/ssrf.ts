/**
 * SSRF protection for outbound webhook delivery (review finding H1).
 *
 * Webhook URLs are operator-supplied; the dispatcher POSTs to them server-side,
 * so without guarding we are a confused deputy that can reach cloud metadata
 * (169.254.169.254), loopback, and RFC1918 hosts. We resolve the target host
 * and reject any URL that resolves to a private/reserved address — both at
 * create time and again at delivery time (DNS-rebinding/TOCTOU defense).
 *
 * Operators who deliberately target a LAN service (e.g. a local Home Assistant)
 * set WEBHOOK_ALLOW_PRIVATE_TARGETS=true to bypass the check.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class SsrfError extends Error {
  override readonly name = "SsrfError";
}

function ipv4IsPrivateOrReserved(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true; // malformed -> treat as unsafe
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8 (RFC1918)
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24
  if (a >= 224) return true; // multicast / reserved (224+)
  return false;
}

function ipv6IsPrivateOrReserved(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified
  // IPv4-mapped (::ffff:a.b.c.d) -> validate the embedded v4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return ipv4IsPrivateOrReserved(mapped[1]!);
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return true; // fe80::/10 link-local
  }
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 ULA
  return false;
}

export function ipIsPrivateOrReserved(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return ipv4IsPrivateOrReserved(ip);
  if (kind === 6) return ipv6IsPrivateOrReserved(ip);
  return true; // not a valid IP -> unsafe
}

/**
 * Validate that a webhook URL is http(s) and (unless allowPrivate) resolves only
 * to public addresses. Returns the validated URL. Throws SsrfError otherwise.
 */
export async function assertSafeWebhookUrl(
  rawUrl: string,
  allowPrivate: boolean,
  resolver: (host: string) => Promise<string[]> = defaultResolve,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError("url must be http(s)");
  }
  if (allowPrivate) return url;

  const host = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  const addresses = isIP(host) ? [host] : await resolver(host);
  if (addresses.length === 0) {
    throw new SsrfError(`could not resolve host ${host}`);
  }
  for (const addr of addresses) {
    if (ipIsPrivateOrReserved(addr)) {
      throw new SsrfError(
        `url resolves to a private/reserved address (${addr}); ` +
          `set WEBHOOK_ALLOW_PRIVATE_TARGETS=true to allow LAN targets`,
      );
    }
  }
  return url;
}

async function defaultResolve(host: string): Promise<string[]> {
  const results = await lookup(host, { all: true });
  return results.map((r) => r.address);
}
