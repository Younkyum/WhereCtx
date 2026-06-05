/**
 * Auth middleware: bearer-token verification and scope guards.
 *
 * Strict parsing at the boundary: a token is accepted ONLY from
 * `Authorization: Bearer <secret>`. Non-Bearer schemes and raw header values are
 * rejected (review finding P1).
 *
 * For device clients that cannot set headers easily (some Shortcut/OwnTracks
 * setups), a `?token=` query parameter is accepted but ONLY on ingest routes
 * (opt-in via `allowQueryToken`). It is never accepted on read/precise/admin
 * routes, because query strings leak into proxy/CDN access logs (CWE-598, review
 * finding P2).
 *
 * Scope checks enforce the role boundary — notably the plan §9.3 rule that
 * device tokens (write_location only) can never read.
 */

import type { Context, MiddlewareHandler } from "hono";
import type { AppContext } from "../app/context.js";
import type { TokenScope } from "../types.js";
import type { AppEnv } from "./types.js";

function extractSecret(c: Context, allowQueryToken: boolean): string | null {
  const header = c.req.header("authorization");
  if (header) {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m) return m[1]!.trim();
    // Any other Authorization scheme is rejected (no raw-token fallback).
    return null;
  }
  if (allowQueryToken) {
    const q = c.req.query("token");
    if (q) return q;
  }
  return null;
}

export interface BearerAuthOptions {
  /** Accept a `?token=` query param. Only enable for device ingest routes. */
  allowQueryToken?: boolean;
}

/** Verify the bearer token and attach it to the context, or 401. */
export function bearerAuth(
  ctx: AppContext,
  options: BearerAuthOptions = {},
): MiddlewareHandler<AppEnv> {
  const allowQueryToken = options.allowQueryToken ?? false;
  return async (c, next) => {
    const secret = extractSecret(c, allowQueryToken);
    const token = await ctx.tokens.verify(secret);
    if (!token) {
      return c.json({ error: "unauthorized" }, 401);
    }
    c.set("token", token);
    await next();
  };
}

/** Require that the authenticated token carries a specific scope, or 403. */
export function requireScope(scope: TokenScope): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = c.get("token");
    if (!token.scopes.includes(scope)) {
      return c.json(
        { error: "forbidden", detail: `requires ${scope} scope` },
        403,
      );
    }
    await next();
  };
}

/** Require at least one of the given scopes (e.g. read or admin), or 403. */
export function requireAnyScope(...scopes: TokenScope[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = c.get("token");
    if (!scopes.some((s) => token.scopes.includes(s))) {
      return c.json(
        { error: "forbidden", detail: `requires one of: ${scopes.join(", ")}` },
        403,
      );
    }
    await next();
  };
}
