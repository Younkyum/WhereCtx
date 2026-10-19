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
 * Device clients get two more forms, accepted ONLY on ingest routes (opt-in
 * via `deviceCredentials`):
 * - `?token=`, for clients that cannot set headers. Query strings leak into
 *   proxy/CDN access logs (CWE-598, review finding P2), so it is never accepted
 *   on read/precise/admin routes.
 * - HTTP Basic with the token as the password (the username is ignored), which
 *   is how OwnTracks authenticates in HTTP mode.
 *
 * Scope checks enforce the role boundary — notably the plan §9.3 rule that
 * device tokens (write_location only) can never read.
 */

import type { Context, MiddlewareHandler } from "hono";
import type { AppContext } from "../app/context.js";
import {
  resolveSessionPrincipal,
  resolveTokenPrincipal,
  type RestPrincipal,
} from "../auth/principal.js";
import { hasFreshAuth } from "../accounts/types.js";
import type { TokenScope } from "../types.js";
import { readSessionCookie, sessionRequestAllowed, setSessionCookie } from "./session.js";
import { refuse } from "./accessAudit.js";
import type { AppEnv, SessionEnv } from "./types.js";

type Presented = { via: "token"; secret: string | null } | { via: "session" };

/** The password of a Basic credential, or null when malformed. */
function basicPassword(encoded: string): string | null {
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon === -1 ? null : decoded.slice(colon + 1) || null;
}

function presentedCredential(c: Context, deviceCredentials: boolean): Presented {
  const header = c.req.header("authorization");
  if (header) {
    const bearer = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (bearer) return { via: "token", secret: bearer[1]!.trim() };
    const basic = deviceCredentials ? /^Basic\s+(\S+)$/i.exec(header.trim()) : null;
    // Any other Authorization scheme is rejected (no raw-token fallback).
    return { via: "token", secret: basic ? basicPassword(basic[1]!) : null };
  }
  if (deviceCredentials) {
    const q = c.req.query("token");
    if (q) return { via: "token", secret: q };
  }
  return { via: "session" };
}

export interface AuthOptions {
  /** Accept `?token=` and Basic auth. Only enable for device ingest routes. */
  deviceCredentials?: boolean;
}

/** The request's principal, or the error response to send instead. */
async function authenticateRequest(
  ctx: AppContext,
  c: Context,
  deviceCredentials: boolean,
): Promise<RestPrincipal | Response> {
  const presented = presentedCredential(c, deviceCredentials);
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
  const deviceCredentials = options.deviceCredentials ?? false;
  return async (c, next) => {
    const principal = await authenticateRequest(ctx, c, deviceCredentials);
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
    c.set("principal", principal);
    if (principal.via !== "session") return refuse(c, 403, "forbidden", "requires a signed-in session");
    const { userId, sessionId, reauthAt } = principal;
    c.set("account", ctx.forSession({ userId, sessionId, reauthAt }));
    await next();
  };
}

/**
 * Only the signed-in person passes; a token gets 403. For views of the owner's
 * own records (the activity logs) that no agent or device should read.
 */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("principal").via !== "session") return refuse(c, 403, "forbidden", "requires a signed-in session");
  await next();
};

/** Require that the authenticated principal carries a specific scope, or 403. */
export function requireScope(scope: TokenScope): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.get("principal").scopes.includes(scope)) {
      return refuse(c, 403, "forbidden", `requires ${scope} scope`);
    }
    await next();
  };
}

/** Require at least one of the given scopes (e.g. read or admin), or 403. */
export function requireAnyScope(...scopes: TokenScope[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { scopes: granted } = c.get("principal");
    if (!scopes.some((s) => granted.includes(s))) {
      return refuse(c, 403, "forbidden", `requires one of: ${scopes.join(", ")}`);
    }
    await next();
  };
}

/**
 * Mark the response uncacheable. For every response that carries a secret
 * (a token, a pairing config, recovery codes), so no browser or proxy cache
 * keeps a copy.
 */
export const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.res.headers.set("Cache-Control", "no-store");
};

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
