/**
 * What the owner can see about who used their data: agent and token reads
 * (access_log) and device uploads (ingest_log). Neither table holds
 * coordinates.
 */

/** The credential behind an agent request. OAuth MCP clients slot in as another kind. */
export const CREDENTIAL_KINDS = ["token", "oauth"] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export interface Credential {
  kind: CredentialKind;
  id: string;
  /** The name the owner gave the token (or the OAuth client's name), kept as it was then. */
  name: string;
}

export const ACCESS_SURFACES = ["rest", "mcp"] as const;
export type AccessSurface = (typeof ACCESS_SURFACES)[number];

/**
 * allowed: the request was served (an empty answer counts).
 * hidden: policy withheld presence from agents (hidden mode).
 * denied: refused (scope, precise policy, a missing reason, a bad request).
 */
export const ACCESS_OUTCOMES = ["allowed", "denied", "hidden"] as const;
export type AccessOutcome = (typeof ACCESS_OUTCOMES)[number];

/** Longest stored precise-access reason and denial text. */
export const ACCESS_TEXT_MAX = 256;

export interface AccessRecord {
  credential: Credential;
  surface: AccessSurface;
  action: string;
  precise: boolean;
  reason?: string;
  outcome: AccessOutcome;
  denial?: string;
}

export interface AccessEntry extends AccessRecord {
  id: string;
  createdAt: string;
}

/** A keyset page: `next` is the `before` cursor for the following page, absent on the last. */
export interface Page<T> {
  entries: T[];
  next?: string;
}
