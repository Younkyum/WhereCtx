/**
 * Privacy / policy engine (plan section 9.3, 5).
 *
 * Pure decision + view-building functions. The API/MCP layer supplies the
 * *live, persisted* PrivacySettings (authoritative — never the per-reading
 * snapshot) and the current presence; this module decides what an agent may see
 * and shapes the response.
 *
 * Core principle: "Presence by default, precise location when needed."
 *
 * Enforcement model (review findings F1/F5/F6):
 *   - defaultAgentAccess "hidden": agents see NOTHING (coarse withheld, precise
 *     denied). This is the strongest mode and is enforced at every read.
 *   - "coarse": agents see presence summary (no raw GPS); precise is gated.
 *   - "precise": same coarse summary; precise is gated by scope + policy + reason.
 *   - Home protection is a DENY, not a blur: when hideHomeExactCoordinates and
 *     the user is at/near a home place, precise location is refused outright.
 *   - The agent-facing coarse view never includes the geohash or raw coords.
 */

import { labelForStatus } from "../geofence/engine.js";
import type {
  CoarsePresenceView,
  PrecisePresenceView,
  PresenceEvent,
  PresenceContext,
  PrivacyMode,
  PrivacySettings,
  TokenScope,
} from "../types.js";
import { hasScope } from "../auth/scopes.js";
import { secondsSince, isStale, type Clock, systemClock } from "../util/time.js";

const ACCESS_ORDER: Record<PrivacyMode, number> = {
  hidden: 0,
  coarse: 1,
  precise: 2,
};

/** Whether `level` grants at least `min` access. */
export function accessAtLeast(level: PrivacyMode, min: PrivacyMode): boolean {
  return ACCESS_ORDER[level] >= ACCESS_ORDER[min];
}

/** Whether a token may read presence at all (read boundary; plan §9.3). */
export function canReadPresence(scopes: TokenScope[]): boolean {
  return hasScope(scopes, "read_presence");
}

/**
 * Build the coarse presence summary. Pure mapping — no raw GPS, no geohash.
 * Used directly for admin/internal views (admin sees everything).
 */
export function buildCoarseView(
  presence: PresenceContext,
  clock: Clock = systemClock,
): CoarsePresenceView {
  return {
    status: presence.status,
    label: presence.label ?? labelForStatus(presence.status),
    motion: presence.motion ?? "unknown",
    updatedAgoSec: secondsSince(presence.updatedAt, clock),
    stale: isStale(presence.updatedAt, presence.staleAfterSec, clock),
    privacy: presence.privacy.mode,
  };
}

/**
 * Agent-facing coarse view. Returns null when the live policy hides presence
 * from agents (`defaultAgentAccess === "hidden"`). The returned view reflects
 * the live policy mode, not the per-reading snapshot (F8).
 */
export function agentCoarseView(
  presence: PresenceContext,
  settings: PrivacySettings,
  clock: Clock = systemClock,
): CoarsePresenceView | null {
  if (!accessAtLeast(settings.defaultAgentAccess, "coarse")) {
    return null; // hidden
  }
  return { ...buildCoarseView(presence, clock), privacy: settings.defaultAgentAccess };
}

/**
 * A presence event as a non-admin agent sees it. Place names would make the
 * feed a movement log of named places (review P4/P5); the people the user
 * shares with are the user's business, not their agents'.
 */
export function agentEventView(event: PresenceEvent): PresenceEvent {
  const { placeName: _p, viewerUserId: _v, ...rest } = event;
  return rest;
}

/** Google Maps link for a coordinate (plan section 9.7). */
export function mapUrl(lat: number, lon: number): string {
  return `https://maps.google.com/?q=${lat},${lon}`;
}

/**
 * Build the precise view with the exact stored coordinates. Gating (including
 * home-coordinate protection) is the responsibility of `authorizePrecise`;
 * this is only called once access has been granted. Returns null if no precise
 * location is available.
 */
export function buildPreciseView(
  presence: PresenceContext,
  clock: Clock = systemClock,
): PrecisePresenceView | null {
  if (!presence.precise) return null;
  const { lat, lon, accuracyM } = presence.precise;
  return {
    lat,
    lon,
    accuracyM,
    mapUrl: mapUrl(lat, lon),
    updatedAgoSec: secondsSince(presence.updatedAt, clock),
  };
}

/** Whether home-coordinate protection applies to the current presence. */
export function shouldHideExact(
  presence: PresenceContext,
  settings: Pick<PrivacySettings, "hideHomeExactCoordinates">,
): boolean {
  return (
    settings.hideHomeExactCoordinates &&
    (presence.status === "home" || presence.status === "near_home")
  );
}

export interface PreciseAuthInput {
  scopes: TokenScope[];
  settings: PrivacySettings;
  presence: PresenceContext;
  reason?: string;
}

export interface PreciseAuthResult {
  allowed: boolean;
  /** Denial reason (when not allowed) for a clear API/MCP message. */
  reason?: string;
}

/**
 * Decide whether a caller may read precise location. Layered deny gate:
 *   1. presence must not be hidden from agents,
 *   2. token must carry `read_precise_location` scope,
 *   3. policy must allow precise location at all,
 *   4. interactive approval must not be required (no approval channel in v0.1),
 *   5. a reason must be supplied when policy requires one,
 *   6. exact home coordinates must not be protected for this reading.
 */
export function authorizePrecise(input: PreciseAuthInput): PreciseAuthResult {
  const { scopes, settings, presence, reason } = input;

  if (settings.defaultAgentAccess === "hidden") {
    return { allowed: false, reason: "presence is hidden from agents by policy" };
  }
  if (!hasScope(scopes, "read_precise_location")) {
    return { allowed: false, reason: "token lacks read_precise_location scope" };
  }
  if (!settings.allowPreciseLocation) {
    return {
      allowed: false,
      reason: "precise location is disabled by policy (allowPreciseLocation=false)",
    };
  }
  if (settings.preciseRequiresApproval) {
    return {
      allowed: false,
      reason:
        "precise location requires interactive approval, which is not available in v0.1",
    };
  }
  if (settings.preciseRequiresReason && !reason?.trim()) {
    return { allowed: false, reason: "a reason is required to access precise location" };
  }
  if (shouldHideExact(presence, settings)) {
    return {
      allowed: false,
      reason: "exact home/near-home coordinates are protected by policy",
    };
  }
  return { allowed: true };
}
