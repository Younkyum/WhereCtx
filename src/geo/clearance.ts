/**
 * How far a stretch of a route runs from the places an agent must not be
 * able to place the person near: the start, the destination, and every
 * registered place as drawn (a circle or a polygon). Distances are measured
 * from each segment of the stretch, not only its points, so a ride whose
 * stops lie far away still counts as near when it passes by.
 *
 * Each keep-out is measured on a local equirectangular plane around its own
 * anchor, accurate to well under a percent at the tens of kilometres a
 * route spans.
 */

import type { Place } from "../types.js";
import type { LatLon } from "./types.js";

const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;

/** A point, or a disc around one (radiusM 0 for a bare point), or a polygon ring in [lon, lat] order. */
export type Keepout =
  | { kind: "disc"; at: LatLon; radiusM: number }
  | { kind: "polygon"; at: LatLon; ring: ReadonlyArray<readonly [number, number]> };

/** The start, the destination and every registered place, each as its shape. */
export function keepouts(points: readonly LatLon[], places: readonly Pick<Place, "lat" | "lon" | "radiusM" | "polygon">[]): Keepout[] {
  return [
    ...points.map((at): Keepout => ({ kind: "disc", at, radiusM: 0 })),
    ...places.map((p): Keepout =>
      p.polygon ? { kind: "polygon", at: { lat: p.lat, lon: p.lon }, ring: p.polygon } : { kind: "disc", at: { lat: p.lat, lon: p.lon }, radiusM: p.radiusM },
    ),
  ];
}

interface Xy {
  x: number;
  y: number;
}

function projector(origin: LatLon): (lat: number, lon: number) => Xy {
  const cosLat = Math.cos(origin.lat * RAD);
  return (lat, lon) => ({ x: (lon - origin.lon) * RAD * EARTH_RADIUS_M * cosLat, y: (lat - origin.lat) * RAD * EARTH_RADIUS_M });
}

function pointToSegment(p: Xy, a: Xy, b: Xy): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

const cross = (o: Xy, a: Xy, b: Xy): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

function segmentsCross(a: Xy, b: Xy, c: Xy, d: Xy): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function segmentToSegment(a: Xy, b: Xy, c: Xy, d: Xy): number {
  if (segmentsCross(a, b, c, d)) return 0;
  return Math.min(pointToSegment(a, c, d), pointToSegment(b, c, d), pointToSegment(c, a, b), pointToSegment(d, a, b));
}

function inside(p: Xy, ring: readonly Xy[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/** The consecutive pairs of a path; a single point pairs with itself. */
function segments(path: readonly Xy[]): Array<[Xy, Xy]> {
  if (path.length === 1) return [[path[0]!, path[0]!]];
  return path.slice(1).map((p, i) => [path[i]!, p]);
}

/** Meters from the nearest part of `path` to the keep-out's edge; 0 when the path touches or enters it. */
export function distanceToKeepout(path: readonly LatLon[], keepout: Keepout): number {
  const at = projector(keepout.at);
  const xy = path.map((p) => at(p.lat, p.lon));
  const pairs = segments(xy);
  if (keepout.kind === "disc") {
    const center = { x: 0, y: 0 };
    let nearest = Infinity;
    for (const [a, b] of pairs) nearest = Math.min(nearest, pointToSegment(center, a, b));
    return Math.max(0, nearest - keepout.radiusM);
  }
  const ring = keepout.ring.map(([lon, lat]) => at(lat, lon));
  if (xy.some((p) => inside(p, ring))) return 0;
  const edges = segments(ring);
  let best = Infinity;
  for (const [a, b] of pairs) for (const [c, d] of edges) best = Math.min(best, segmentToSegment(a, b, c, d));
  return best;
}

/** Whether a stretch has geometry and runs farther than `clearanceM` from every keep-out. */
export function clearOf(path: readonly LatLon[], avoid: readonly Keepout[], clearanceM: number): boolean {
  return path.length > 0 && avoid.every((k) => distanceToKeepout(path, k) > clearanceM);
}
