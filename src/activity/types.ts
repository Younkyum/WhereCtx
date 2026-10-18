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

/** Which ingest route a reading arrived on. */
export const INGEST_ROUTES = ["generic", "shortcut", "owntracks"] as const;
export type IngestRoute = (typeof INGEST_ROUTES)[number];

/**
 * accepted: the reading updated presence.
 * rejected: the payload could not be read, or the credential may not write.
 * ignored: an OwnTracks message that is not a location (a waypoint, a status).
 */
export const INGEST_OUTCOMES = ["accepted", "rejected", "ignored"] as const;
export type IngestOutcome = (typeof INGEST_OUTCOMES)[number];

export interface IngestVerdict {
  outcome: IngestOutcome;
  reason?: string;
}

export interface IngestRecord extends IngestVerdict {
  /** The device token, or null for a reading posted from the dashboard session. */
  token: { id: string; name: string } | null;
  source: IngestRoute;
}

export interface IngestEntry extends IngestVerdict {
  id: string;
  token: { id: string; name: string } | null;
  source: IngestRoute;
  receivedAt: string;
}

export interface DeviceSummary {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastReceivedAt: string | null;
  lastOutcome: IngestOutcome | null;
  accepted24h: number;
  rejected24h: number;
}
