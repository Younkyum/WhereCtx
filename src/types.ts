/**
 * Core domain types for WhereCtx.
 *
 * These mirror the data models in the product plan (section 10) and act as the
 * single source of truth for the normalized presence format that every
 * downstream component (privacy engine, geofence, store, MCP, REST) consumes.
 */

export type PresenceStatus =
  | "unknown"
  | "home"
  | "away"
  | "near_home"
  | "work"
  | "near_work"
  | "transit"
  | "custom";

export type Motion =
  | "stationary"
  | "walking"
  | "running"
  | "driving"
  | "transit"
  | "unknown";

export type IngestSource =
  | "ios_shortcut"
  | "mobile_app"
  | "owntracks"
  | "tasker"
  | "home_assistant"
  | "manual";

export type PrivacyMode = "hidden" | "coarse" | "precise";

export type PlaceType = "home" | "work" | "custom";

export type CoarsePlaceType = "home" | "work" | "station" | "store" | "unknown";

export type TokenRole = "device" | "agent" | "admin";

export interface PreciseLocation {
  lat: number;
  lon: number;
  accuracyM?: number;
  altitudeM?: number;
  speedMps?: number;
  headingDeg?: number;
}

export interface CoarseLocation {
  geohash?: string;
  city?: string;
  area?: string;
  placeType?: CoarsePlaceType;
}

export interface BatteryInfo {
  level: number;
  charging?: boolean;
}

export interface PresencePrivacy {
  mode: PrivacyMode;
  allowPreciseToAgents: boolean;
}

/**
 * The normalized presence record. Produced by the normalizer, refined by the
 * geofence engine, persisted by the store, and filtered by the privacy engine
 * before it ever reaches an agent.
 */
export interface PresenceContext {
  userId: string;
  status: PresenceStatus;
  label?: string;
  precise?: PreciseLocation;
  coarse?: CoarseLocation;
  motion?: Motion;
  battery?: BatteryInfo;
  source: IngestSource;
  privacy: PresencePrivacy;
  /** ISO timestamp reported by the device. */
  updatedAt: string;
  /** ISO timestamp the server received the update. */
  receivedAt: string;
  /** Seconds after `updatedAt` at which this reading is considered stale. */
  staleAfterSec: number;
}

export interface Place {
  id: string;
  name: string;
  label?: string;
  lat: number;
  lon: number;
  radiusM: number;
  type: PlaceType;
  createdAt: string;
  updatedAt: string;
}

export type PresenceEventType =
  | "presence.updated"
  | "presence.entered_place"
  | "presence.left_place"
  | "presence.became_stale"
  | "presence.privacy_changed";

export interface PresenceEvent {
  id: string;
  type: PresenceEventType;
  placeName?: string;
  status?: string;
  source?: string;
  createdAt: string;
}

/** Default geofence radius (meters) when a caller omits it (REST + MCP). */
export const DEFAULT_PLACE_RADIUS_M = 150;

/**
 * Agent-facing place view: name + type only. lat/lon (the home address),
 * radiusM (geofence size), and label (often the literal street address) are
 * deliberately omitted for non-admin callers (review P6). Shared by the REST
 * places API and the MCP `list_places` tool so the two surfaces cannot drift.
 */
export function sanitizePlace(place: Place): { name: string; type: PlaceType } {
  return { name: place.name, type: place.type };
}

export type TokenScope =
  | "write_location"
  | "read_presence"
  | "read_precise_location"
  | "manage_places"
  | "manage_tokens"
  | "manage_privacy";

export interface Token {
  id: string;
  name: string;
  role: TokenRole;
  scopes: TokenScope[];
  createdAt: string;
  lastUsedAt?: string;
}

/** Default scope sets per role (plan section 10.4). */
export const ROLE_SCOPES: Record<TokenRole, TokenScope[]> = {
  device: ["write_location"],
  agent: ["read_presence", "read_precise_location"],
  admin: [
    "read_presence",
    "read_precise_location",
    "manage_places",
    "manage_tokens",
    "manage_privacy",
  ],
};

/** Persisted privacy/policy settings (plan section 9.3). */
export interface PrivacySettings {
  defaultAgentAccess: PrivacyMode;
  allowPreciseLocation: boolean;
  preciseRequiresReason: boolean;
  preciseRequiresApproval: boolean;
  hideHomeExactCoordinates: boolean;
  /**
   * When true (default), creating or overwriting a `home` place requires the
   * `manage_places` scope even on surfaces that allow agent place-writes (MCP).
   * Toggleable from the dashboard; protects the home geofence from being moved
   * by a read-scoped agent, which would mislead the home-coordinate privacy
   * protections.
   */
  protectHomePlace: boolean;
  retentionHours: number;
  storeRawHistory: boolean;
}

/** Coarse presence view returned to agents by default (plan section 5). */
export interface CoarsePresenceView {
  status: PresenceStatus;
  label: string;
  motion: Motion;
  updatedAgoSec: number;
  stale: boolean;
  privacy: PrivacyMode;
}

/** Precise presence view, only returned when policy allows (plan section 9.7). */
export interface PrecisePresenceView {
  lat: number;
  lon: number;
  accuracyM?: number;
  mapUrl: string;
  updatedAgoSec: number;
}
