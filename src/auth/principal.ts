/**
 * Who a request acts as, resolved once from its credential. REST (`bearerAuth`)
 * and MCP (`mcpNodeHandler`) both go through `resolvePrincipal`, so there is one
 * identity path; handlers then work only through `ctx.forUser(principal.userId)`.
 */

import type { AppContext } from "../app/context.js";
import type { TokenScope, UserId } from "../types.js";

export interface Principal {
  userId: UserId;
  scopes: TokenScope[];
}

export async function resolvePrincipal(
  ctx: Pick<AppContext, "system">,
  secret: string | null | undefined,
): Promise<Principal | null> {
  const token = await ctx.system.tokens.verify(secret);
  return token && { userId: token.userId, scopes: token.scopes };
}
