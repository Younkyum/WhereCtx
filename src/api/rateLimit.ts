/**
 * In-memory fixed-window rate limiting (review finding M1), used three ways:
 *   - failed authentications per client, shared by REST and the raw-Node MCP
 *     handler so both surfaces count against one budget;
 *   - requests per client on the unauthenticated ceremony starters
 *     (`/v1/auth/{flow}/options`, `/v1/auth/recover`), which cost a signature
 *     or a database read even when they succeed;
 *   - failures per recovery-code lookup id, so one account's codes cannot be
 *     hammered from many addresses.
 *
 * Memory is bounded by `maxEntries`. Once the table is full, keys it does not
 * already track share one overflow counter instead of going uncounted, so
 * rotating through fresh keys (spoofed or not) still runs into the limit.
 *
 * Client identity follows TRUST_PROXY: proxy headers are read only when the
 * operator says every request comes through that proxy; otherwise the socket
 * peer address is the client.
 */

import type { Context, MiddlewareHandler } from "hono";
import type { IncomingMessage } from "node:http";
import type { TrustProxy } from "../config.js";
import { systemClock, type Clock } from "../util/time.js";

export interface RateLimiterOptions {
  windowMs?: number;
  /** Hits within one window after which a key is blocked. */
  max?: number;
  maxEntries?: number;
  clock?: Clock;
}

const OVERFLOW_KEY = "\u0000overflow";

export class RateLimiter {
  private readonly windowMs: number;
  private readonly max: number;
  private readonly maxEntries: number;
  private readonly clock: Clock;
  private windowStart = 0;
  private readonly counts = new Map<string, number>();

  constructor(opts: RateLimiterOptions = {}) {
    this.windowMs = opts.windowMs ?? 60_000;
    this.max = opts.max ?? 30;
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.clock = opts.clock ?? systemClock;
  }

  isBlocked(key: string): boolean {
    this.rotate();
    return (this.counts.get(this.slot(key)) ?? 0) >= this.max;
  }

  record(key: string): void {
    this.rotate();
    const slot = this.slot(key);
    this.counts.set(slot, (this.counts.get(slot) ?? 0) + 1);
  }

  private rotate(): void {
    const now = this.clock().getTime();
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.counts.clear();
    }
  }

  /** The counter `key` uses: its own, or the shared overflow once the table is full. */
  private slot(key: string): string {
    if (this.counts.has(key) || this.counts.size < this.maxEntries) return key;
    return OVERFLOW_KEY;
  }
}

function firstHop(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.split(",")[0]?.trim() || undefined;
}

/** The client address of a raw Node request, per TRUST_PROXY. */
export function nodeClientKey(req: IncomingMessage, trust: TrustProxy): string {
  const header =
    trust === "cloudflare"
      ? firstHop(req.headers["cf-connecting-ip"])
      : trust === "xff"
        ? firstHop(req.headers["x-forwarded-for"])
        : undefined;
  return header ?? req.socket.remoteAddress ?? "unknown";
}

/** The client address of a Hono request on @hono/node-server, per TRUST_PROXY. */
export function clientKey(c: Context, trust: TrustProxy): string {
  const header =
    trust === "cloudflare"
      ? firstHop(c.req.header("cf-connecting-ip"))
      : trust === "xff"
        ? firstHop(c.req.header("x-forwarded-for"))
        : undefined;
  const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
  return header ?? incoming?.socket?.remoteAddress ?? "unknown";
}

const tooMany = (c: Context, what: string) => c.json({ error: `too many ${what}; retry later` }, 429);

/** 429 for blocked clients; counts each 401 response as a failure. */
export function authFailureGuard(limiter: RateLimiter, trust: TrustProxy): MiddlewareHandler {
  return async (c, next) => {
    const key = clientKey(c, trust);
    if (limiter.isBlocked(key)) return tooMany(c, "failed authentication attempts");
    await next();
    if (c.res.status === 401) limiter.record(key);
  };
}

/** 429 for blocked clients; counts every request. */
export function requestGuard(limiter: RateLimiter, trust: TrustProxy): MiddlewareHandler {
  return async (c, next) => {
    const key = clientKey(c, trust);
    if (limiter.isBlocked(key)) return tooMany(c, "requests");
    limiter.record(key);
    await next();
  };
}
