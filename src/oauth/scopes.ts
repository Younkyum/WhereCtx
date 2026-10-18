/**
 * The OAuth scopes an MCP client may ask for, and what each one lets its
 * access token do on /mcp. This table is the only place they are defined:
 * the authorization server advertises it, consent decides from it, and /mcp
 * maps a token's scopes through it.
 *
 * `always` scopes are granted whenever requested; `opt-in` scopes only when the
 * person ticks them on the consent screen. Precise location stays gated by the
 * privacy settings either way.
 */

import type { TokenScope } from "../types.js";

export const OAUTH_SCOPES = {
  "presence:read": { tokenScope: "read_presence", consent: "always" },
  "location:precise": { tokenScope: "read_precise_location", consent: "opt-in" },
} as const satisfies Record<string, { tokenScope: TokenScope; consent: "always" | "opt-in" }>;

export type OAuthScope = keyof typeof OAUTH_SCOPES;

export const RESOURCE_SCOPES = Object.keys(OAUTH_SCOPES) as OAuthScope[];

export function isOAuthScope(scope: string): scope is OAuthScope {
  return Object.hasOwn(OAUTH_SCOPES, scope);
}

/** The OAuth scopes in a space-separated scope string, in registry order. */
export function parseOAuthScopes(scope: string | undefined): OAuthScope[] {
  const present = new Set(scope?.split(" "));
  return RESOURCE_SCOPES.filter((s) => present.has(s));
}

export function tokenScopesFor(scope: string | undefined): TokenScope[] {
  return parseOAuthScopes(scope).map((s) => OAUTH_SCOPES[s].tokenScope);
}

/** The OAuth scope a client must hold to get `tokenScope`, for insufficient_scope challenges. */
export function oauthScopeFor(tokenScope: TokenScope): OAuthScope | undefined {
  return RESOURCE_SCOPES.find((s) => OAUTH_SCOPES[s].tokenScope === tokenScope);
}

/**
 * Whether consent grants a requested scope. Scopes outside the table are the
 * protocol's own (offline_access), which carry no access and are granted.
 */
export function consentGrants(scope: string, optedIn: ReadonlySet<OAuthScope>): boolean {
  if (!isOAuthScope(scope)) return true;
  return OAUTH_SCOPES[scope].consent === "always" || optedIn.has(scope);
}
