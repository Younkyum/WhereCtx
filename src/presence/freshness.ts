/**
 * How far to trust a presence reading, from how the device reports.
 *
 * OwnTracks in significant-change mode, a Shortcut automation and most apps
 * report on movement and stay quiet at rest: OwnTracks iOS publishes nothing
 * "even if you don't move for hours" apart from an occasional ping, and
 * Android pings every 15 minutes by default
 * (https://owntracks.org/booklet/features/location/). So silence from such a
 * device means "has not moved much", and only a long silence
 * (DEVICE_OFFLINE_AFTER_SEC) means the device is offline. A manual reading has
 * no device behind it, so it simply ages (STALE_AFTER_SEC).
 */

import { haversineMeters } from "../geofence/distance.js";
import type { Freshness, IngestSource, PresenceContext, PresenceStatus } from "../types.js";
import { isStale, secondsSince, type Clock } from "../util/time.js";

/** A new position this close to the last one is the same spot: GPS jitter, a ping. */
export const MOVED_THRESHOLD_M = 100;

/** Statuses that place the person inside a registered place. */
const INSIDE_PLACE: ReadonlySet<PresenceStatus> = new Set(["home", "work", "custom"]);

/** How long a reading from `source` stays fresh before it counts as stale. */
export function staleAfterFor(source: IngestSource, config: { staleAfterSec: number; deviceOfflineAfterSec: number }): number {
  return source === "manual" ? config.staleAfterSec : config.deviceOfflineAfterSec;
}

/** When the person arrived at `next`: carried over from `prev` while they stay within MOVED_THRESHOLD_M. */
export function movedAtFor(
  prev: Pick<PresenceContext, "precise" | "movedAt" | "updatedAt"> | null,
  next: { lat: number; lon: number },
  updatedAt: string,
): string {
  if (!prev?.precise) return updatedAt;
  const d = haversineMeters(prev.precise.lat, prev.precise.lon, next.lat, next.lon);
  return d <= MOVED_THRESHOLD_M ? (prev.movedAt ?? prev.updatedAt) : updatedAt;
}

export interface FreshnessView {
  stale: boolean;
  freshness: Freshness;
  lastReportAgoSec: number;
  lastMovedAgoSec?: number;
  likelyStationary: boolean;
}

/** `liveWithinSec`: STALE_AFTER_SEC, how recent a report must be to count as live. */
export function freshnessOf(presence: PresenceContext, liveWithinSec: number, clock: Clock): FreshnessView {
  const lastReportAgoSec = secondsSince(presence.updatedAt, clock);
  const stale = isStale(presence.updatedAt, presence.staleAfterSec, clock);
  const recent = lastReportAgoSec <= liveWithinSec;
  const atRest = INSIDE_PLACE.has(presence.status) || presence.motion === "stationary";
  const freshness: Freshness =
    presence.source === "manual"
      ? stale
        ? "unknown"
        : atRest
          ? "stationary"
          : "live"
      : stale
        ? "offline"
        : recent && !atRest
          ? "live"
          : "stationary";
  return {
    stale,
    freshness,
    lastReportAgoSec,
    ...(presence.movedAt ? { lastMovedAgoSec: secondsSince(presence.movedAt, clock) } : {}),
    likelyStationary: freshness === "stationary",
  };
}
