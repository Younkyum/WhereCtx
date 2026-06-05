/**
 * Token scope helpers (plan section 10.4).
 *
 * Enforcement rule (plan section 9.3): the "device tokens can never read
 * location" guarantee is realized here by scope membership — device tokens only
 * ever carry `write_location`, never any `read_*` scope — and must be checked at
 * every read boundary, not by role convention alone.
 */

import { ROLE_SCOPES, type TokenRole, type TokenScope } from "../types.js";

export { ROLE_SCOPES };

export function scopesForRole(role: TokenRole): TokenScope[] {
  return [...ROLE_SCOPES[role]];
}

export function hasScope(scopes: TokenScope[], required: TokenScope): boolean {
  return scopes.includes(required);
}

export function hasAnyScope(scopes: TokenScope[], required: TokenScope[]): boolean {
  return required.some((s) => scopes.includes(s));
}
