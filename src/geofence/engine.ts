/**
 * Geofence engine: turn a coordinate + registered places into a presence
 * status. Pure and spatial — motion-based refinement (e.g. away -> transit) is
 * applied separately by the presence service.
 *
 * Status rules (plan section 9.5):
 *   - inside a place (shape.ts `measurePlace`): home -> home, work -> work,
 *     custom -> custom. The containing place with the closest anchor wins.
 *   - near a home/work place (its near band): near_home / near_work. Custom
 *     places have no "near" variant.
 *   - otherwise, with a valid location: away.
 *   - no places registered or no location: unknown.
 *
 * The containing place is the raw verdict. Dwell rules (dwell.ts) decide when
 * it becomes the confirmed place, and `statusFor` gives the status of
 * whatever is confirmed.
 */

import type { Place, PresenceStatus } from "../types.js";
import { isValidCoordinate } from "./distance.js";
import { measurePlace } from "./shape.js";

export interface GeofenceResult {
  status: PresenceStatus;
  /** Human label, e.g. "home", "near work", or a custom place's name. */
  label: string;
  /** The place the user is currently inside, if any. */
  matchedPlace?: Place;
  /** The status as if the point were inside no place: near_home, near_work, away or unknown. */
  outside: { status: PresenceStatus; label: string };
  /** Closest place (inside or not) and its distance. */
  nearestPlace?: Place;
  nearestDistanceM?: number;
}

const STATUS_LABELS: Record<PresenceStatus, string> = {
  unknown: "unknown",
  home: "home",
  away: "away",
  near_home: "near home",
  work: "work",
  near_work: "near work",
  transit: "in transit",
  custom: "custom",
};

/** Default label for a status when no place-specific label applies. */
export function labelForStatus(status: PresenceStatus): string {
  return STATUS_LABELS[status];
}


export function computeGeofence(
  lat: number,
  lon: number,
  places: Place[],
  nearMultiplier: number,
): GeofenceResult {
  const unknown = { status: "unknown" as const, label: STATUS_LABELS.unknown };
  if (!isValidCoordinate(lat, lon) || places.length === 0) {
    return { ...unknown, outside: unknown };
  }

  const ranked = places
    .map((place) => ({ place, ...measurePlace(place, lat, lon, nearMultiplier) }))
    .sort((a, b) => a.anchorDistanceM - b.anchorDistanceM);

  // ranked[0] exists because places.length > 0.
  const nearest = { nearestPlace: ranked[0]!.place, nearestDistanceM: ranked[0]!.anchorDistanceM };

  // Considering "near" for home/work places only.
  const near = ranked.find((r) => r.near && (r.place.type === "home" || r.place.type === "work"));
  const outsideStatus: PresenceStatus = near ? (near.place.type === "home" ? "near_home" : "near_work") : "away";
  const outside = { status: outsideStatus, label: STATUS_LABELS[outsideStatus] };

  const inside = ranked.find((r) => r.inside);
  if (inside) {
    return { ...statusFor(inside.place, outside), matchedPlace: inside.place, outside, ...nearest };
  }
  return { ...outside, outside, ...nearest };
}

/** The status and label of being in `confirmed`, or `outside` with no confirmed place. */
export function statusFor(
  confirmed: Place | undefined,
  outside: GeofenceResult["outside"],
): { status: PresenceStatus; label: string } {
  if (!confirmed) return outside;
  const status = insideStatus(confirmed);
  return { status, label: placeLabel(confirmed, status) };
}

function insideStatus(place: Place): PresenceStatus {
  switch (place.type) {
    case "home":
      return "home";
    case "work":
      return "work";
    default:
      return "custom";
  }
}

function placeLabel(place: Place, status: PresenceStatus): string {
  if (place.type === "custom") {
    return place.label ?? place.name;
  }
  return place.label ?? STATUS_LABELS[status];
}
