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
 * denied: refused (scope, precise policy, a missing reason, a bad request, an unknown route or tool).
 * error: the server failed; nothing was decided about the caller.
 */
export const ACCESS_OUTCOMES = ["allowed", "denied", "hidden", "error"] as const;
export type AccessOutcome = (typeof ACCESS_OUTCOMES)[number];

/**
 * What became of one request, set by the code that decided it (a scope
 * guard, the privacy policy, a handler) and read by the REST and MCP
 * recorders. `precise` says the request sought or returned coordinates.
 */
export interface AccessDecision {
  outcome: AccessOutcome;
  denial?: string;
  precise?: boolean;
}

/**
 * Every action the access log names: the REST routes (api/accessAudit.ts),
 * the MCP tools (mcp/server.ts), and three catch-alls. Tests hold both
 * surfaces to this list, and the dashboard has copy for each.
 */
export const ACCESS_ACTIONS = [
  "presence.read",
  "presence.precise",
  "presence.history",
  "places.list",
  "places.write",
  "places.delete",
  "events.list",
  "privacy.read",
  "privacy.update",
  "webhooks.list",
  "webhooks.create",
  "webhooks.update",
  "webhooks.delete",
  "webhooks.dead_letters",
  "tokens.list",
  "tokens.create",
  "tokens.revoke",
  "devices.list",
  "devices.pair",
  "activity.read",
  "admin.logs",
  /** Any route that only a signed-in person may use; a token is always refused there. */
  "account",
  /** A REST path no route matched, or an MCP tool that does not exist. Never the raw path or name. */
  "unknown",
  /** An MCP request from a token without read_presence, refused before any tool ran. */
  "mcp.request",
  "get_presence",
  "get_precise_location",
  "is_near_place",
  "list_places",
  "get_location_age",
  "list_recent_presence_events",
  "create_location_reminder",
  "create_place",
  "remember_current_place",
] as const;
export type AccessAction = (typeof ACCESS_ACTIONS)[number];

/** Longest stored precise-access reason and denial text. */
export const ACCESS_TEXT_MAX = 256;

export interface AccessRecord {
  credential: Credential;
  surface: AccessSurface;
  action: AccessAction;
  precise: boolean;
  reason?: string;
  outcome: AccessOutcome;
  denial?: string;
}

export interface AccessEntry extends AccessRecord {
  id: string;
  /** Identical requests within a minute of each other, from createdAt to lastAt. */
  count: number;
  createdAt: string;
  lastAt: string;
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
 * error: the server failed while handling it.
 */
export const INGEST_OUTCOMES = ["accepted", "rejected", "ignored", "error"] as const;
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
