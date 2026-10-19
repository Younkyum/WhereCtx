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

/** The 16 bytes of an address `isIP` already accepted as IPv6 (zone id dropped). */
function ipv6Bytes(ip: string): Uint8Array {
  let text = ip.split("%")[0]!;
  const bytes = new Uint8Array(16);
  const lastColon = text.lastIndexOf(":");
  const dotted = text.slice(lastColon + 1).includes(".") ? text.slice(lastColon + 1).split(".").map(Number) : null;
  if (dotted) text = `${text.slice(0, lastColon + 1)}0:0`;
  const [head, tail] = text.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail === undefined ? [] : tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  groups.forEach((group, i) => {
    const n = Number.parseInt(group, 16);
    bytes[2 * i] = n >> 8;
    bytes[2 * i + 1] = n & 0xff;
  });
  if (dotted) bytes.set(dotted, 12);
  return bytes;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((b, i) => bytes[i] === b);
}

function embeddedV4(bytes: Uint8Array, at: number, mask = 0): string {
  return [0, 1, 2, 3].map((i) => bytes[at + i]! ^ mask).join(".");
}

const ZEROS_80 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/**
 * IPv6 is judged on its bytes, so every spelling of an address
 * (`::ffff:127.0.0.1`, `::ffff:7f00:1`, `[::7f00:1]`) gets the same answer.
 * Addresses that carry an IPv4 address and reach it get that address's rule.
 */
function ipv6IsPrivateOrReserved(ip: string): boolean {
  const b = ipv6Bytes(ip);
  // ::ffff:0:0/96 IPv4-mapped.
  if (startsWith(b, [...ZEROS_80, 0xff, 0xff])) return ipv4IsPrivateOrReserved(embeddedV4(b, 12));
  // ::/96 IPv4-compatible, which also covers :: and ::1.
  if (startsWith(b, [...ZEROS_80, 0, 0])) return ipv4IsPrivateOrReserved(embeddedV4(b, 12));
  // 64:ff9b::/96 NAT64: the gateway forwards to the embedded IPv4.
  if (startsWith(b, [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0])) return ipv4IsPrivateOrReserved(embeddedV4(b, 12));
  // 64:ff9b:1::/48 local-use NAT64 (RFC 8215): a site's own translator.
  if (startsWith(b, [0, 0x64, 0xff, 0x9b, 0, 1])) return true;
  // 2002::/16 6to4: the relay forwards to the IPv4 in bytes 2-5.
  if (startsWith(b, [0x20, 0x02])) return ipv4IsPrivateOrReserved(embeddedV4(b, 2));
  // 2001::/32 Teredo: the server's IPv4 in bytes 4-7, the client's inverted in 12-15.
  if (startsWith(b, [0x20, 0x01, 0, 0])) {
    return ipv4IsPrivateOrReserved(embeddedV4(b, 4)) || ipv4IsPrivateOrReserved(embeddedV4(b, 12, 0xff));
  }
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique local
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
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await resolver(host);
  } catch {
    addresses = [];
  }
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
