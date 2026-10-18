/**
 * Who a request acts as, resolved once from its credential. Two kinds exist:
 * - token: an agent, device, or automation presenting a Bearer secret. REST and
 *   MCP both resolve it through `resolveTokenPrincipal`. Its scopes are the
 *   token's own.
 * - session: a person signed in with a passkey, carrying the session cookie.
 *   They act on their own data with every self-service scope.
 * Handlers then work only through `ctx.forUser(principal.userId)`.
 */

import type { AppContext } from "../app/context.js";
import type { SessionId } from "../accounts/types.js";
import { ROLE_SCOPES, type TokenScope, type UserId } from "../types.js";

/** A signed-in person may do everything to their own data. */
export const SESSION_SCOPES: readonly TokenScope[] = ["write_location", ...ROLE_SCOPES.admin];

export type Principal =
  | { via: "token"; userId: UserId; scopes: TokenScope[] }
  | {
      via: "session";
      userId: UserId;
      scopes: TokenScope[];
      sessionId: SessionId;
      /** Last passkey proof of this session (see accounts/types.ts hasFreshAuth). */
      reauthAt: string;
    };

export type SessionPrincipal = Extract<Principal, { via: "session" }>;

export async function resolveTokenPrincipal(
  ctx: Pick<AppContext, "system">,
  secret: string | null | undefined,
): Promise<Principal | null> {
  const token = await ctx.system.tokens.verify(secret);
  return token && { via: "token", userId: token.userId, scopes: token.scopes };
}

/** `renewed` means the session's expiry slid forward and the cookie should be re-sent. */
export async function resolveSessionPrincipal(
  ctx: Pick<AppContext, "system">,
  cookie: string | undefined,
): Promise<{ principal: SessionPrincipal; renewed: boolean } | null> {
  const session = await ctx.system.sessions.verify(cookie);
  if (!session) return null;
  return {
    principal: {
      via: "session",
      userId: session.userId,
      scopes: [...SESSION_SCOPES],
      sessionId: session.sessionId,
      reauthAt: session.reauthAt,
    },
    renewed: session.renewed,
  };
}
