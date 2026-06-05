/**
 * Geofence engine: turn a coordinate + registered places into a presence
 * status. Pure and spatial — motion-based refinement (e.g. away -> transit) is
 * applied separately by the presence service.
 *
 * Status rules (plan section 9.5):
 *   - inside a place (distance <= radiusM): home -> home, work -> work,
 *     custom -> custom. Closest containing place wins.
 *   - near a home/work place (distance <= radiusM * nearMultiplier): near_home
 *     / near_work. Custom places have no "near" variant.
 *   - otherwise, with a valid location: away.
 *   - no places registered or no location: unknown.
 */

import type { Place, PresenceStatus } from "../types.js";
import { haversineMeters, isValidCoordinate } from "./distance.js";

export interface GeofenceResult {
  status: PresenceStatus;
  /** Human label, e.g. "home", "near work", or a custom place's name. */
  label: string;
  /** The place the user is currently inside, if any. */
  matchedPlace?: Place;
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

interface Ranked {
  place: Place;
  distanceM: number;
  inside: boolean;
  near: boolean;
}

export function computeGeofence(
  lat: number,
  lon: number,
  places: Place[],
  nearMultiplier: number,
): GeofenceResult {
  if (!isValidCoordinate(lat, lon)) {
    return { status: "unknown", label: STATUS_LABELS.unknown };
  }
  if (places.length === 0) {
    return { status: "unknown", label: STATUS_LABELS.unknown };
  }

  const ranked: Ranked[] = places
    .map((place) => {
      const distanceM = haversineMeters(lat, lon, place.lat, place.lon);
      return {
        place,
        distanceM,
        inside: distanceM <= place.radiusM,
        near: distanceM <= place.radiusM * nearMultiplier,
      };
    })
    .sort((a, b) => a.distanceM - b.distanceM);

  // ranked[0] exists because places.length > 0.
  const nearest = ranked[0]!;

  const inside = ranked.find((r) => r.inside);
  if (inside) {
    const status = insideStatus(inside.place);
    return {
      status,
      label: placeLabel(inside.place, status),
      matchedPlace: inside.place,
      nearestPlace: nearest.place,
      nearestDistanceM: nearest.distanceM,
    };
  }

  // Not inside anything: consider "near" for home/work places only.
  const near = ranked.find(
    (r) => r.near && (r.place.type === "home" || r.place.type === "work"),
  );
  if (near) {
    const status: PresenceStatus =
      near.place.type === "home" ? "near_home" : "near_work";
    return {
      status,
      label: STATUS_LABELS[status],
      nearestPlace: nearest.place,
      nearestDistanceM: nearest.distanceM,
    };
  }

  return {
    status: "away",
    label: STATUS_LABELS.away,
    nearestPlace: nearest.place,
    nearestDistanceM: nearest.distanceM,
  };
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
