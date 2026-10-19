/**
 * How far to trust a presence reading, from how its source reports and when
 * the server last heard from it.
 *
 * OwnTracks in significant-change mode and the other apps that keep a
 * background connection report on movement and stay quiet at rest:
 * OwnTracks iOS publishes nothing "even if you don't move for hours" apart
 * from an occasional ping, and Android pings every 15 minutes by default
 * (https://owntracks.org/booklet/features/location/). So silence from such a
 * device means "has not moved much", and only a long silence
 * (DEVICE_OFFLINE_AFTER_SEC) means it is offline. A manual reading, a
 * Shortcut automation and a Tasker task send only when something fires them
 * and keep no connection to judge, so they age out after STALE_AFTER_SEC and
 * are then `unknown`, never `offline`.
 *
 * Every age here is from `receivedAt`, the server's clock: a device clock
 * that runs fast or a queue of old points uploaded late cannot make a
 * reading look newer than when it arrived. The window is worked out from the
 * source and the config at read time, so a config change applies to the
 * readings already stored.
 */

import { haversineMeters } from "../geofence/distance.js";
import type { LatLon } from "../geo/types.js";
import type { Freshness, IngestSource, Motion, PresenceContext, PresenceStatus } from "../types.js";
import { secondsSince, type Clock } from "../util/time.js";

/** A new position this close to where the person arrived is the same spot: GPS jitter, a ping. */
export const MOVED_THRESHOLD_M = 100;

export interface FreshnessConfig {
  /** How recent a report must be to count as live; the whole window of a source that keeps no connection. */
  staleAfterSec: number;
  /** How long a connected device may stay quiet before it counts as offline. */
  deviceOfflineAfterSec: number;
}

/**
 * connected: an app with a background connection that pings while at rest.
 * triggered: something fires each report (a person, an automation), with no
 * connection behind it.
 */
const SOURCE_KIND: Record<IngestSource, "connected" | "triggered"> = {
  owntracks: "connected",
  mobile_app: "connected",
  home_assistant: "connected",
  ios_shortcut: "triggered",
  tasker: "triggered",
  manual: "triggered",
};

/** Statuses that place the person inside a registered place. */
const INSIDE_PLACE: ReadonlySet<PresenceStatus> = new Set(["home", "work", "custom"]);
const MOVING: ReadonlySet<Motion> = new Set(["walking", "running", "driving", "transit"]);

/** Seconds without a report after which a reading from `source` is too old to trust. */
export function offlineAfterSec(source: IngestSource, config: FreshnessConfig): number {
  return SOURCE_KIND[source] === "connected" ? config.deviceOfflineAfterSec : config.staleAfterSec;
}

/** Past its source's window: a connected device has gone offline, or a triggered reading has aged out. */
export function isPastWindow(reading: Pick<PresenceContext, "source" | "receivedAt">, config: FreshnessConfig, clock: Clock): boolean {
  return secondsSince(reading.receivedAt, clock) > offlineAfterSec(reading.source, config);
}

/** Where and when the person arrived at the spot they are at now. */
export interface Arrival {
  movedAt: string;
  movedFrom: LatLon;
}

/**
 * The arrival for a new position: kept while it stays within
 * MOVED_THRESHOLD_M of where the person arrived (not of the last report, so
 * a slow drift of small steps still counts as moving), else this report.
 */
export function arrivalFor(
  prev: { precise?: LatLon; movedAt?: string; movedFrom?: LatLon; receivedAt: string } | null,
  next: LatLon,
  receivedAt: string,
): Arrival {
  const anchor = prev?.movedFrom ?? prev?.precise;
  if (!prev || !anchor) return { movedAt: receivedAt, movedFrom: { lat: next.lat, lon: next.lon } };
  return haversineMeters(anchor.lat, anchor.lon, next.lat, next.lon) <= MOVED_THRESHOLD_M
    ? { movedAt: prev.movedAt ?? prev.receivedAt, movedFrom: anchor }
    : { movedAt: receivedAt, movedFrom: { lat: next.lat, lon: next.lon } };
}

export interface FreshnessView {
  /** Past its source's window (see `freshness`). */
  stale: boolean;
  freshness: Freshness;
  /** Seconds since the server last heard from the source, pings included. */
  lastReportAgoSec: number;
  /** Seconds since the person arrived where they are now. */
  lastMovedAgoSec?: number;
}

export function freshnessOf(presence: PresenceContext, config: FreshnessConfig, clock: Clock): FreshnessView {
  const lastReportAgoSec = secondsSince(presence.receivedAt, clock);
  const stale = lastReportAgoSec > offlineAfterSec(presence.source, config);
  const atRest = INSIDE_PLACE.has(presence.status) || presence.motion === "stationary";
  const wasMoving = presence.status === "transit" || MOVING.has(presence.motion ?? "unknown");
  const freshness: Freshness = stale
    ? SOURCE_KIND[presence.source] === "connected"
      ? "offline"
      : "unknown"
    : lastReportAgoSec <= config.staleAfterSec
      ? atRest
        ? "stationary"
        : "live"
      : // Quiet but connected: at rest, unless the last report was on the move and then stopped.
        wasMoving && !atRest
        ? "unknown"
        : "stationary";
  return {
    stale,
    freshness,
    lastReportAgoSec,
    ...(presence.movedAt ? { lastMovedAgoSec: secondsSince(presence.movedAt, clock) } : {}),
  };
}
