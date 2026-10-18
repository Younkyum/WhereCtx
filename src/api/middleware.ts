/**
 * Auth middleware: credential resolution and scope guards.
 *
 * A request authenticates with exactly one credential:
 * - A Bearer token, accepted ONLY from `Authorization: Bearer <secret>`.
 *   Non-Bearer schemes and raw header values are rejected (review finding P1).
 *   Any Authorization header selects this path, so a Bearer wins over a cookie.
 * - Otherwise the session cookie of a signed-in person, subject to the CSRF
 *   Origin rule in ./session.ts.
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
import {
  resolveSessionPrincipal,
  resolveTokenPrincipal,
  type Principal,
} from "../auth/principal.js";
import { hasFreshAuth } from "../accounts/types.js";
import type { TokenScope } from "../types.js";
import { readSessionCookie, sessionRequestAllowed, setSessionCookie } from "./session.js";
import type { AppEnv, SessionEnv } from "./types.js";

type Presented = { via: "token"; secret: string | null } | { via: "session" };

function presentedCredential(c: Context, allowQueryToken: boolean): Presented {
  const header = c.req.header("authorization");
  if (header) {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    // Any other Authorization scheme is rejected (no raw-token fallback).
    return { via: "token", secret: m ? m[1]!.trim() : null };
  }
  if (allowQueryToken) {
    const q = c.req.query("token");
    if (q) return { via: "token", secret: q };
  }
  return { via: "session" };
}

export interface AuthOptions {
  /** Accept a `?token=` query param. Only enable for device ingest routes. */
  allowQueryToken?: boolean;
}

/** The request's principal, or the error response to send instead. */
async function authenticateRequest(
  ctx: AppContext,
  c: Context,
  allowQueryToken: boolean,
): Promise<Principal | Response> {
  const presented = presentedCredential(c, allowQueryToken);
  if (presented.via === "token") {
    return (
      (await resolveTokenPrincipal(ctx, presented.secret)) ??
      c.json({ error: "unauthorized" }, 401)
    );
  }
  const cookie = readSessionCookie(c, ctx.config.baseUrl);
  const session = await resolveSessionPrincipal(ctx, cookie);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  if (!sessionRequestAllowed(c, ctx.config.baseUrl)) {
    return c.json({ error: "forbidden", detail: "cross-origin request refused" }, 403);
  }
  if (session.renewed) setSessionCookie(c, cookie!, ctx.config.baseUrl);
  return session.principal;
}

/**
 * Attach the principal (token or session) and its user scope, or 401.
 * Mounted by `buildApp`, the only REST code that holds the full context.
 */
export function authenticate(ctx: AppContext, options: AuthOptions = {}): MiddlewareHandler<AppEnv> {
  const allowQueryToken = options.allowQueryToken ?? false;
  return async (c, next) => {
    const principal = await authenticateRequest(ctx, c, allowQueryToken);
    if (principal instanceof Response) return principal;
    c.set("principal", principal);
    c.set("scope", ctx.forUser(principal.userId));
    await next();
  };
}

/**
 * Like `authenticate`, but only a signed-in person passes (tokens belong to
 * agents and devices, which hold no account or workspace rights), and the
 * handler gets that person's account scope instead of a user scope.
 */
export function sessionAuth(ctx: AppContext): MiddlewareHandler<SessionEnv> {
  return async (c, next) => {
    const principal = await authenticateRequest(ctx, c, false);
    if (principal instanceof Response) return principal;
    if (principal.via !== "session") {
      return c.json({ error: "forbidden", detail: "requires a signed-in session" }, 403);
    }
    const { userId, sessionId, reauthAt } = principal;
    c.set("account", ctx.forSession({ userId, sessionId, reauthAt }));
    await next();
  };
}

/** Require that the authenticated principal carries a specific scope, or 403. */
export function requireScope(scope: TokenScope): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.get("principal").scopes.includes(scope)) {
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
    const { scopes: granted } = c.get("principal");
    if (!scopes.some((s) => granted.includes(s))) {
      return c.json(
        { error: "forbidden", detail: `requires one of: ${scopes.join(", ")}` },
        403,
      );
    }
    await next();
  };
}

/**
 * A session must have proved its passkey within the step-up window; token
 * principals pass (a token is its own proof). Used where a session mints a
 * long-lived credential.
 */
export function requireFreshSession(ctx: Pick<AppContext, "clock">): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get("principal");
    if (principal.via === "session" && !hasFreshAuth(principal.reauthAt, ctx.clock())) {
      return c.json(
        { error: "confirm with your passkey first (POST /v1/me/reauth)", code: "reauth_required" },
        403,
      );
    }
    await next();
  };
}
