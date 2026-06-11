/**
 * In-memory rate limiting for failed authentications (review finding M1).
 *
 * Token entropy (256-bit) makes brute force cryptographically infeasible; the
 * limiter exists to stop an unauthenticated client from generating unbounded
 * auth-failure load / log noise. Fixed window, keyed by client IP, with a hard
 * cap on tracked keys so spoofed IPs cannot grow memory without bound.
 *
 * Shared between the Hono REST app and the raw-Node MCP handler so both
 * surfaces count against the same budget.
 */

import type { Context, MiddlewareHandler } from "hono";
import type { IncomingMessage } from "node:http";
import { systemClock, type Clock } from "../util/time.js";

export interface AuthFailureLimiterOptions {
  windowMs?: number;
  maxFailures?: number;
  maxEntries?: number;
  clock?: Clock;
}

export class AuthFailureLimiter {
  private readonly windowMs: number;
  private readonly maxFailures: number;
  private readonly maxEntries: number;
  private readonly clock: Clock;
  private windowStart = 0;
  private readonly counts = new Map<string, number>();

  constructor(opts: AuthFailureLimiterOptions = {}) {
    this.windowMs = opts.windowMs ?? 60_000;
    this.maxFailures = opts.maxFailures ?? 30;
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.clock = opts.clock ?? systemClock;
  }

  private rotate(): void {
    const now = this.clock().getTime();
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.counts.clear();
    }
  }

  isBlocked(key: string): boolean {
    this.rotate();
    return (this.counts.get(key) ?? 0) >= this.maxFailures;
  }

  recordFailure(key: string): void {
    this.rotate();
    // Bound memory under key churn; existing keys keep counting.
    if (this.counts.size >= this.maxEntries && !this.counts.has(key)) return;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }
}

/**
 * Best-effort client key. Prefers proxy-provided headers (cloudflared /
 * reverse proxy) and falls back to the socket address. The headers are
 * spoofable when the server is exposed directly — acceptable for a
 * failure-count limiter (worst case an attacker rotates keys, which the
 * maxEntries cap bounds; legitimate clients authenticate and are unaffected).
 */
function honoClientKey(c: Context): string {
  const fwd = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  const remote = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming
    ?.socket?.remoteAddress;
  return remote ?? "unknown";
}

export function nodeClientKey(req: IncomingMessage): string {
  const fwd = req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd;
  if (first) return first.split(",")[0]!.trim();
  return req.socket.remoteAddress ?? "unknown";
}

/** Hono middleware: 429 for blocked keys; counts 401 responses as failures. */
export function authFailureGuard(limiter: AuthFailureLimiter): MiddlewareHandler {
  return async (c, next) => {
    const key = honoClientKey(c);
    if (limiter.isBlocked(key)) {
      return c.json({ error: "too many failed authentication attempts; retry later" }, 429);
    }
    await next();
    if (c.res.status === 401) limiter.recordFailure(key);
  };
}
