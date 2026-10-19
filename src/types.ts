/**
 * Core domain types for WhereCtx.
 *
 * These mirror the data models in the product plan (section 10) and act as the
 * single source of truth for the normalized presence format that every
 * downstream component (privacy engine, geofence, store, MCP, REST) consumes.
 */

import type { GeoProviderName } from "./geo/types.js";

/**
 * Owner of every row of user data. Branded so a raw string (a place name, a
 * token id) can never be passed where a tenant key is expected; construct one
 * only at a boundary (config, DB row, verified credential) via `asUserId`.
 */
export type UserId = string & { readonly __brand: "UserId" };

export function asUserId(raw: string): UserId {
  if (raw.length === 0) throw new Error("userId must be a non-empty string");
  return raw as UserId;
}

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
  userId: UserId;
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
  /** Device time of the first reading at the current spot (pings and readings at rest keep it). */
  movedAt?: string;
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

/** How much of their location a person shares with another member. */
export const SHARE_LEVELS = ["coarse", "precise"] as const;
export type ShareLevel = (typeof SHARE_LEVELS)[number];

/**
 * The owner's record of a share's life, kept in `share_audit` and never in
 * presence events, so agents, MCP, `/v1/events` and webhooks see none of it.
 */
export const SHARE_AUDIT_ACTIONS = ["granted", "changed", "revoked", "precise_viewed"] as const;
export type ShareAuditAction = (typeof SHARE_AUDIT_ACTIONS)[number];
/** Why a share ended other than its owner revoking it. */
export type ShareAuditReason = "membership_ended" | "viewer_declined";

export const PRESENCE_EVENT_TYPES = [
  "presence.updated",
  "presence.entered_place",
  "presence.left_place",
  "presence.became_stale",
  "presence.privacy_changed",
] as const;
export type PresenceEventType = (typeof PRESENCE_EVENT_TYPES)[number];

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
  userId: UserId;
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
  /**
   * Hide this person from everyone they share their location with, without
   * touching the shares. Agents are governed by `defaultAgentAccess` alone.
   */
  sharingPaused: boolean;
  /**
   * Master switch for maps: no provider call is made with this person's
   * location, and no area is kept, while it is off. Off by default.
   */
  geoEnabled: boolean;
  /** Agents' coarse presence may include the neighbourhood (presence area). */
  areaToAgents: boolean;
  /** The default `showArea` of a new location share. */
  areaToPeople: boolean;
  /** Agents may ask for an ETA or directions from the current location. */
  etaToAgents: boolean;
  /** No provider call with the live location while at or near home. On by default. */
  skipProviderNearHome: boolean;
  /** The provider to use; null picks the first one with a key. */
  geoProvider: GeoProviderName | null;
}

/** Most points one GET /v1/presence/history returns, and how many by default. */
export const HISTORY_MAX_POINTS = 5000;
export const HISTORY_DEFAULT_POINTS = 1000;

/**
 * How much to trust the presence now. live: reported within STALE_AFTER_SEC
 * and on the move. stationary: at rest or quiet, which a device that reports
 * only on movement does while staying put; treat as still at the last place.
 * offline: no report for longer than the device should go quiet. unknown: a
 * manual reading too old to say.
 */
export const FRESHNESS = ["live", "stationary", "offline", "unknown"] as const;
export type Freshness = (typeof FRESHNESS)[number];

/** Coarse presence view returned to agents by default (plan section 5). */
export interface CoarsePresenceView {
  status: PresenceStatus;
  label: string;
  motion: Motion;
  updatedAgoSec: number;
  /**
   * The device appears offline: no report for longer than it should go
   * quiet (DEVICE_OFFLINE_AFTER_SEC; STALE_AFTER_SEC for a manual reading).
   * Not set merely because the person has not moved.
   */
  stale: boolean;
  /** Seconds since the device last reported, pings included. */
  lastReportAgoSec: number;
  /** Seconds since the reported position last changed by more than about 100 m. */
  lastMovedAgoSec?: number;
  /** No recent movement and no sign the device is offline: still at the last place. */
  likelyStationary: boolean;
  freshness: Freshness;
  privacy: PrivacyMode;
  /**
   * The neighbourhood ("성남시 분당구 삼평동"), when maps are on and the
   * person lets agents see it (areaToAgents). Region names only.
   */
  area?: string;
}

/** Precise presence view, only returned when policy allows (plan section 9.7). */
export interface PrecisePresenceView {
  lat: number;
  lon: number;
  accuracyM?: number;
  mapUrl: string;
  updatedAgoSec: number;
}
