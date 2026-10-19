/**
 * The one spatial primitive every point-against-place check uses: the
 * geofence engine, MCP is_near_place, history's place labels, the maps
 * near-home guard and approach detection all call `measurePlace`, so a
 * polygon place behaves the same everywhere a circle does.
 */

import type { Place, Ring } from "../types.js";
import { haversineMeters } from "./distance.js";
import { insidePolygon, measurePolygon, polygonFrame, type PolygonFrame } from "./polygon.js";

export type PlaceShape =
  | { kind: "circle"; lat: number; lon: number; radiusM: number }
  | { kind: "polygon"; frame: PolygonFrame };

type Shaped = Pick<Place, "lat" | "lon" | "radiusM" | "polygon">;

/**
 * Projected rings by ring, so history or a sweep measuring many points
 * against the same places projects each ring once, not once per point.
 */
const frames = new WeakMap<Ring, PolygonFrame>();

function frameOf(ring: Ring, lat: number, lon: number): PolygonFrame {
  const cached = frames.get(ring);
  if (cached && cached.origin.lat === lat && cached.origin.lon === lon) return cached;
  const frame = polygonFrame(ring, { lat, lon });
  frames.set(ring, frame);
  return frame;
}

export function placeShape(place: Shaped): PlaceShape {
  return place.polygon
    ? { kind: "polygon", frame: frameOf(place.polygon, place.lat, place.lon) }
    : { kind: "circle", lat: place.lat, lon: place.lon, radiusM: place.radiusM };
}

export interface PlaceMeasure {
  /** Inside the place or on its boundary. */
  inside: boolean;
  /**
   * Within the near band: radius x nearMultiplier for a circle; for a
   * polygon, the band a circle of the same area gets, measured outward from
   * its boundary.
   */
  near: boolean;
  /** 0 inside or on the boundary, else meters to the boundary. */
  edgeDistanceM: number;
  /** Meters to the anchor (a circle's center, a polygon's centroid); ranks overlapping places. */
  anchorDistanceM: number;
}

export function measurePlace(place: Shaped, lat: number, lon: number, nearMultiplier: number): PlaceMeasure {
  const shape = placeShape(place);
  const anchorDistanceM = haversineMeters(lat, lon, place.lat, place.lon);
  switch (shape.kind) {
    case "circle":
      return {
        inside: anchorDistanceM <= shape.radiusM,
        near: anchorDistanceM <= shape.radiusM * nearMultiplier,
        edgeDistanceM: Math.max(0, anchorDistanceM - shape.radiusM),
        anchorDistanceM,
      };
    case "polygon": {
      const { inside, edgeDistanceM } = measurePolygon(shape.frame, lat, lon);
      const band = (nearMultiplier - 1) * Math.sqrt(shape.frame.areaM2 / Math.PI);
      return { inside, near: edgeDistanceM <= band, edgeDistanceM, anchorDistanceM };
    }
  }
}

/** Whether the point is inside the place or on its boundary: measurePlace without the distances. */
export function insidePlace(place: Shaped, lat: number, lon: number): boolean {
  const shape = placeShape(place);
  return shape.kind === "circle"
    ? haversineMeters(lat, lon, shape.lat, shape.lon) <= shape.radiusM
    : insidePolygon(shape.frame, lat, lon);
}

/** The home place the point is at or near (inside it or in its near band), nearest first. */
export function nearHomePlace(point: { lat: number; lon: number }, places: readonly Place[], nearMultiplier: number): Place | null {
  let best: { place: Place; d: number } | null = null;
  for (const place of places) {
    if (place.type !== "home") continue;
    const m = measurePlace(place, point.lat, point.lon, nearMultiplier);
    if (m.near && (!best || m.anchorDistanceM < best.d)) best = { place, d: m.anchorDistanceM };
  }
  return best?.place ?? null;
}
