/**
 * Who a request acts as, resolved once from its credential. Three kinds exist:
 * - token: an agent, device, or automation presenting a Bearer secret. REST and
 *   MCP both resolve it through `resolveTokenPrincipal`. Its scopes are the
 *   token's own.
 * - session: a person signed in with a passkey, carrying the session cookie.
 *   They act on their own data with every self-service scope.
 * - oauth: an MCP client presenting an OAuth access token a person consented
 *   to. Only /mcp accepts it (`resolveBearerPrincipal`); the token's audience
 *   is /mcp, so REST never resolves it. Its scopes come from the OAuth scope
 *   registry (oauth/scopes.ts).
 * Handlers then work only through `ctx.forUser(principal.userId)`.
 */

import type { AppContext } from "../app/context.js";
import type { SessionId } from "../accounts/types.js";
import { tokenScopesFor } from "../oauth/scopes.js";
import { ROLE_SCOPES, type TokenScope, type UserId } from "../types.js";
import { TOKEN_PREFIX } from "./tokens.js";

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
    }
  | { via: "oauth"; userId: UserId; scopes: TokenScope[]; grantId: string; clientId: string };

export type SessionPrincipal = Extract<Principal, { via: "session" }>;
export type TokenPrincipal = Extract<Principal, { via: "token" }>;
/** What REST accepts: every principal but OAuth, whose tokens only /mcp honours. */
export type RestPrincipal = Exclude<Principal, { via: "oauth" }>;

export async function resolveTokenPrincipal(
  ctx: Pick<AppContext, "system">,
  secret: string | null | undefined,
): Promise<TokenPrincipal | null> {
  const token = await ctx.system.tokens.verify(secret);
  return token && { via: "token", userId: token.userId, scopes: token.scopes };
}

/**
 * A Bearer secret on /mcp: a WhereCtx token (including bootstrap tokens, which
 * need not carry the `wctx_` prefix) or else an OAuth access token.
 */
export async function resolveBearerPrincipal(
  ctx: Pick<AppContext, "system" | "oauth">,
  secret: string | null | undefined,
): Promise<Principal | null> {
  const token = await resolveTokenPrincipal(ctx, secret);
  if (token || !secret || secret.startsWith(`${TOKEN_PREFIX}_`)) return token;
  const access = await ctx.oauth.verifyAccessToken(secret);
  return (
    access && {
      via: "oauth",
      userId: access.userId,
      scopes: tokenScopesFor(access.scope),
      grantId: access.grantId,
      clientId: access.clientId,
    }
  );
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
