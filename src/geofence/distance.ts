/**
 * Geographic distance + geohash helpers.
 * Pure functions — no I/O, fully unit-testable.
 */

import ngeohash from "ngeohash";

const EARTH_RADIUS_M = 6_371_008.8; // mean Earth radius (meters)

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Great-circle distance between two WGS84 coordinates, in meters (haversine).
 */
export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

/**
 * Encode a coordinate to a geohash. Precision 6 (~1.2km cell) is a sensible
 * default for "coarse" presence: enough to convey an area, not a street.
 */
export function encodeGeohash(lat: number, lon: number, precision = 6): string {
  return ngeohash.encode(lat, lon, precision);
}

/** Basic coordinate sanity check. */
export function isValidCoordinate(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}
