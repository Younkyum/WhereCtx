/**
 * The API's JSON shapes as the dashboard reads them (docs/api.md), plus the
 * closed value sets it turns into i18n keys. Server strings outside a set fall
 * back through `oneOf`, so a new server value never yields a missing key.
 */

import type { WorkspaceRole } from "../../src/accounts/types";
import type { AccessEntry as ServerAccessEntry } from "../../src/activity/types";
import type { GeoProviderName } from "../../src/geo/types";

export type { WorkspaceRole };
export {
  ACCESS_ACTIONS,
  ACCESS_OUTCOMES,
  INGEST_OUTCOMES,
  type AccessAction,
  type AccessOutcome,
  type DeviceSummary,
  type IngestEntry,
  type IngestOutcome,
} from "../../src/activity/types";

export const STATUSES = ["home", "near_home", "away", "work", "near_work", "transit", "custom", "unknown"] as const;
export type Status = (typeof STATUSES)[number];
export const MOTIONS = ["stationary", "walking", "running", "driving", "transit"] as const;
export type Motion = (typeof MOTIONS)[number];
export const SHARE_LEVELS = ["off", "coarse", "precise"] as const;
export type ShareLevel = (typeof SHARE_LEVELS)[number];
export type GrantedLevel = Exclude<ShareLevel, "off">;
export const AGENT_ACCESS = ["hidden", "coarse", "precise"] as const;
export type AgentAccess = (typeof AGENT_ACCESS)[number];
export const PLACE_TYPES = ["home", "work", "custom"] as const;
export type PlaceType = (typeof PLACE_TYPES)[number];
export type TokenRole = "device" | "agent" | "admin";
export type AuditAction = "granted" | "changed" | "revoked" | "precise_viewed";
export type AuditReason = "membership_ended" | "viewer_declined";
export type Withheld = "at_home" | "no_home_place";
export const PRIVACY_FLAGS = [
  "allowPreciseLocation",
  "preciseRequiresReason",
  "preciseRequiresApproval",
  "hideHomeExactCoordinates",
  "protectHomePlace",
  "storeRawHistory",
] as const;
export type PrivacyFlag = (typeof PRIVACY_FLAGS)[number];

export function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export interface UserRef {
  id: string;
  displayName: string;
}

export interface WorkspaceMembership {
  id: string;
  name: string;
  role: WorkspaceRole;
}

export interface Me {
  user: UserRef;
  /** The instance owner, who may read the server's logs. */
  isOperator?: boolean;
  workspaces: WorkspaceMembership[];
  passkeys: { id: string; name: string; createdAt: string; lastUsedAt: string | null }[];
  sessions: { id: string; userAgent: string | null; createdAt: string; lastSeenAt: string; current: boolean }[];
}

/** How far to trust a presence (src/types.ts FRESHNESS). */
export type Freshness = "live" | "stationary" | "offline" | "unknown";

export interface Presence {
  status: string;
  stale: boolean;
  freshness?: Freshness;
  motion?: string | null;
  updatedAgoSec: number;
  /** The neighbourhood, while maps are on. */
  area?: string;
}

export { GEO_PROVIDERS, type GeoProviderName } from "../../src/geo/types";

/** The maps switches, each a privacy setting (PUT /v1/privacy). */
export const GEO_FLAGS = ["geoEnabled", "skipProviderNearHome", "areaOnHome", "areaToAgents", "etaToAgents", "areaToPeople"] as const;
export type GeoFlag = (typeof GEO_FLAGS)[number];

export type PrivacySettings = Record<PrivacyFlag, boolean> &
  Record<GeoFlag, boolean> & {
    defaultAgentAccess: AgentAccess;
    retentionHours: number;
    sharingPaused: boolean;
    geoProvider: GeoProviderName | null;
  };

export interface GeoCredential {
  provider: GeoProviderName;
  /** unusable: the saved row cannot be opened; save the key again. */
  status: "ok" | "unusable";
  /** Each key kind held, with its last four characters ("" for a secret). */
  kinds: Record<string, string>;
  updatedAt: string;
  lastUsedAt: string | null;
  lastError: string | null;
}

export interface GeoStatus {
  active: { provider: GeoProviderName; source: "own" | "operator" } | null;
  /** The provider whose map this dashboard loads, and whose key. */
  map: { provider: GeoProviderName; source: "own" | "operator" } | null;
  credentials: GeoCredential[];
  operator: GeoProviderName[];
  operatorMap: GeoProviderName[];
}

export interface GeoCandidate {
  label: string;
  address: string;
  roadAddress?: string;
  lat: number;
  lon: number;
  kind: "address" | "place";
}

export interface Eta {
  destination: { label: string; kind: "place" | "address" };
  origin: "current_location" | "home";
  precision: "exact" | "approximate";
  durationMin: number;
  distanceKm: number;
  traffic: "live" | "predicted";
  arriveAt: string;
  summary: string[];
  /** The route as drawn on a map (the owner's own answers). */
  path?: { lat: number; lon: number }[];
  provider: GeoProviderName;
  deepLinks?: { kakaoMap: string; naverMap: string };
}

export interface PreciseLocation {
  lat: number;
  lon: number;
  accuracyM?: number | null;
  updatedAgoMin: number;
  mapUrl?: string;
}

/** My own point (GET /v1/presence/precise, signed in). */
export interface MyPoint {
  lat: number;
  lon: number;
  accuracyM?: number | null;
  updatedAgoSec: number;
  /** I am near this home place while the map provider is kept away from there: a map shows the place, not my point. */
  nearHome?: { name: string; lat: number; lon: number; radiusM: number };
}

export interface Person {
  user: UserRef;
  level: GrantedLevel;
  paused: boolean;
  presence: { status: string; stale: boolean; freshness?: Freshness; motion?: string | null; updatedAgoMin: number; area?: string } | null;
  precise?: "available" | PreciseLocation | null;
  preciseWithheld?: Withheld | null;
}

export interface ShareTerms {
  level: GrantedLevel;
  hideHomeExact?: boolean;
  showArea?: boolean;
}

export interface Shares {
  outgoing: ({ viewer: UserRef } & ShareTerms)[];
  incoming: { owner: UserRef; level: GrantedLevel }[];
}

export interface AuditEntry {
  id?: string;
  action: AuditAction;
  before?: ShareTerms | null;
  after?: ShareTerms | null;
  reason?: AuditReason | null;
  viewer?: UserRef | null;
  createdAt: string;
}

export interface Member {
  userId: string;
  displayName: string;
  role: WorkspaceRole;
  joinedAt: string;
}

export interface Invite {
  id: string;
  role: WorkspaceRole;
  createdAt: string;
  expiresAt: string;
}

export interface InvitePreview {
  workspaceName: string;
  role: WorkspaceRole;
  expiresAt: string;
}

export interface Place {
  name: string;
  type: PlaceType;
  lat: number;
  lon: number;
  radiusM: number;
}

export interface PresenceEvent {
  id: string;
  type: string;
  placeName?: string | null;
  createdAt: string;
}

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  active: boolean;
}

export interface DeadLetter {
  id: string;
  eventType: string;
  error?: string | null;
  createdAt: string;
}

export interface ApiToken {
  id: string;
  name: string;
  role: TokenRole;
  lastUsedAt: string | null;
}

export type Pairing =
  | { kind: "owntracks"; link: string; qrSvg: string; config: unknown }
  | { kind: "shortcut"; url: string; headers: { Authorization: string } };

export type OAuthScope = "presence:read" | "location:precise";

/** A pending authorization from an MCP client, as the consent screen shows it. */
export interface ConsentRequest {
  client: { id: string; name: string | null; uri: string | null };
  redirectUri: string;
  redirectHost: string;
  localhostOnly: boolean;
  requestedScopes: OAuthScope[];
  resource: string;
}

/** An MCP client the person authorized with OAuth. */
export interface ConnectedApp {
  id: string;
  clientId: string;
  clientName: string | null;
  scopes: OAuthScope[];
  createdAt: string;
  expiresAt: string | null;
}

/** A WebAuthn ceremony the server started: an opaque handle plus the options JSON. */
export interface CeremonyStart<O> {
  ceremony: string;
  options: O;
}

export interface HistoryPoint {
  id: string;
  recordedAt: string;
  lat: number;
  lon: number;
  accuracyM?: number;
  source?: string;
  /** The place whose geofence held the point, by today's places. */
  place?: string;
}

export interface History {
  enabled: boolean;
  retentionHours: number;
  from: string;
  to: string;
  truncated: boolean;
  points: HistoryPoint[];
}

/** An access log row as JSON. */
export type AccessEntry = ServerAccessEntry;

/** A keyset page from the activity endpoints. */
export interface LogPage<T> {
  entries: T[];
  next?: string;
}

export { LOG_LEVELS, type LogEntry, type LogLevel } from "../../src/util/logEntry";
export { HISTORY_MAX_POINTS } from "../../src/types";
