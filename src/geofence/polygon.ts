/**
 * Polygon geometry for polygon places. Pure functions.
 *
 * Rings are GeoJSON-style [lon, lat] positions. Every measurement projects
 * them onto a local equirectangular plane in meters around an origin (the
 * place's centroid), which stays accurate to well under a percent at the
 * 100 km a place may span.
 */

import type { Ring } from "../types.js";
import { haversineMeters, isValidCoordinate } from "./distance.js";

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

export const POLYGON_MIN_VERTICES = 3;
export const POLYGON_MAX_VERTICES = 200;
export const POLYGON_MIN_AREA_M2 = 100;
/** The same bound a circle's radiusM has. */
export const POLYGON_MAX_CIRCUMRADIUS_M = 100_000;
/** A point this close to an edge is on the boundary, which counts as inside. */
const ON_EDGE_M = 0.01;

interface Xy {
  x: number;
  y: number;
}

interface Origin {
  lat: number;
  lon: number;
}

/** lon - origin.lon in [-180, 180): a point across the antimeridian is the short way round. */
function lonOffset(lon: number, origin: Origin): number {
  return ((((lon - origin.lon + 180) % 360) + 360) % 360) - 180;
}

function project(lon: number, lat: number, origin: Origin, cosLat = Math.cos(toRad(origin.lat))): Xy {
  return {
    x: EARTH_RADIUS_M * toRad(lonOffset(lon, origin)) * cosLat,
    y: EARTH_RADIUS_M * toRad(lat - origin.lat),
  };
}

function unproject(p: Xy, origin: Origin): Origin {
  return {
    lat: origin.lat + toDeg(p.y / EARTH_RADIUS_M),
    lon: origin.lon + toDeg(p.x / (EARTH_RADIUS_M * Math.cos(toRad(origin.lat)))),
  };
}

/** The ring's vertices projected around `origin`, closing position dropped. */
function projectRing(ring: Ring, origin: Origin): Xy[] {
  return ring.slice(0, -1).map(([lon, lat]) => project(lon, lat, origin));
}

function signedArea(pts: readonly Xy[]): number {
  let twice = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    twice += a.x * b.y - b.x * a.y;
  }
  return twice / 2;
}

function vertexMean(ring: Ring): Origin {
  const open = ring.slice(0, -1);
  const lat = open.reduce((s, [, la]) => s + la, 0) / open.length;
  const lon = open.reduce((s, [lo]) => s + lo, 0) / open.length;
  return { lat, lon };
}

/** Area-weighted centroid of a closed ring (may fall outside a concave ring). */
export function polygonCentroid(ring: Ring): Origin {
  const origin = vertexMean(ring);
  const pts = projectRing(ring, origin);
  const area = signedArea(pts);
  if (area === 0) return origin;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const cross = a.x * b.y - b.x * a.y;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  return unproject({ x: cx / (6 * area), y: cy / (6 * area) }, origin);
}

/** Area of a closed ring in square meters. */
export function polygonAreaM2(ring: Ring, origin: Origin = vertexMean(ring)): number {
  return Math.abs(signedArea(projectRing(ring, origin)));
}

/** The farthest vertex from `center`, in meters. */
export function circumradiusM(ring: Ring, center: Origin): number {
  return Math.max(...ring.map(([lon, lat]) => haversineMeters(center.lat, center.lon, lat, lon)));
}

function segmentDistance(p: Xy, a: Xy, b: Xy): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export interface PolygonMeasure {
  /** Inside the ring or on its boundary. */
  inside: boolean;
  /** 0 inside or on the boundary, else meters to the nearest edge. */
  edgeDistanceM: number;
}

/** A ring projected once around `origin` (its place's centroid), for measuring many points. */
export interface PolygonFrame {
  origin: Origin;
  cosLat: number;
  pts: readonly Xy[];
  areaM2: number;
  /** The projected bounding box, grown by ON_EDGE_M. */
  box: { minX: number; maxX: number; minY: number; maxY: number };
}

export function polygonFrame(ring: Ring, origin: Origin): PolygonFrame {
  const pts = projectRing(ring, origin);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return {
    origin,
    cosLat: Math.cos(toRad(origin.lat)),
    pts,
    areaM2: Math.abs(signedArea(pts)),
    box: {
      minX: Math.min(...xs) - ON_EDGE_M,
      maxX: Math.max(...xs) + ON_EDGE_M,
      minY: Math.min(...ys) - ON_EDGE_M,
      maxY: Math.max(...ys) + ON_EDGE_M,
    },
  };
}

/** Ray casting: strictly inside, the boundary aside. */
function crossesOdd(pts: readonly Xy[], p: Xy): boolean {
  let odd = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) odd = !odd;
  }
  return odd;
}

function nearestEdgeM(pts: readonly Xy[], p: Xy): number {
  let d = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) d = Math.min(d, segmentDistance(p, pts[i]!, pts[j]!));
  return d;
}

/** Where (lat, lon) falls against a projected ring. */
export function measurePolygon({ origin, cosLat, pts }: PolygonFrame, lat: number, lon: number): PolygonMeasure {
  const p = project(lon, lat, origin, cosLat);
  if (crossesOdd(pts, p)) return { inside: true, edgeDistanceM: 0 };
  const edgeDistanceM = nearestEdgeM(pts, p);
  return edgeDistanceM <= ON_EDGE_M ? { inside: true, edgeDistanceM: 0 } : { inside: false, edgeDistanceM };
}

/** Whether (lat, lon) is inside the ring or on its boundary, without measuring how far outside it is. */
export function insidePolygon({ origin, cosLat, pts, box }: PolygonFrame, lat: number, lon: number): boolean {
  const p = project(lon, lat, origin, cosLat);
  if (p.x < box.minX || p.x > box.maxX || p.y < box.minY || p.y > box.maxY) return false;
  return crossesOdd(pts, p) || nearestEdgeM(pts, p) <= ON_EDGE_M;
}

/** Collinear when the angle at `a` between ab and ac is below about 1e-9 rad, whatever the scale. */
const COLLINEAR_SIN = 1e-9;

function orient(a: Xy, b: Xy, c: Xy): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const v = abx * acy - aby * acx;
  return Math.abs(v) <= COLLINEAR_SIN * Math.hypot(abx, aby) * Math.hypot(acx, acy) ? 0 : Math.sign(v);
}

function onSegment(a: Xy, b: Xy, p: Xy): boolean {
  return (
    Math.min(a.x, b.x) - 1e-9 <= p.x &&
    p.x <= Math.max(a.x, b.x) + 1e-9 &&
    Math.min(a.y, b.y) - 1e-9 <= p.y &&
    p.y <= Math.max(a.y, b.y) + 1e-9
  );
}

/** Whether segments ab and cd share any point, touching and collinear overlap included. */
function segmentsMeet(a: Xy, b: Xy, c: Xy, d: Xy): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (
    (o1 === 0 && onSegment(a, b, c)) ||
    (o2 === 0 && onSegment(a, b, d)) ||
    (o3 === 0 && onSegment(c, d, a)) ||
    (o4 === 0 && onSegment(c, d, b))
  );
}

/** Adjacent edges a->b, b->c fold back over each other. */
function foldsBack(a: Xy, b: Xy, c: Xy): boolean {
  return orient(a, b, c) === 0 && (a.x - b.x) * (c.x - b.x) + (a.y - b.y) * (c.y - b.y) > 0;
}

function selfIntersects(pts: readonly Xy[]): boolean {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    if (foldsBack(a, b, pts[(i + 2) % n]!)) return true;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsMeet(a, b, pts[j]!, pts[(j + 1) % n]!)) return true;
    }
  }
  return false;
}

export interface ValidPolygon {
  /** Closed: the first position repeats as the last. */
  ring: Ring;
  centroid: Origin;
  circumradiusM: number;
  areaM2: number;
}

export type PolygonCheck = { ok: true; polygon: ValidPolygon } | { ok: false; error: string };

/**
 * Validate a GeoJSON-style ring, open or closed, and close it. The single
 * check the REST and MCP surfaces share; the message names the rule broken.
 */
export function validatePolygon(input: ReadonlyArray<readonly [number, number]>): PolygonCheck {
  const fail = (error: string): PolygonCheck => ({ ok: false, error });
  for (const [i, [lon, lat]] of input.entries()) {
    if (!isValidCoordinate(lat, lon)) return fail(`polygon position ${i} is not a valid [lon, lat]`);
  }
  if (input.length === 0) return fail(`polygon needs ${POLYGON_MIN_VERTICES} to ${POLYGON_MAX_VERTICES} vertices`);
  const first = input[0]!;
  const last = input[input.length - 1]!;
  const closed = first[0] === last[0] && first[1] === last[1] && input.length > 1;
  const ring: Ring = closed ? input.map(([lon, lat]) => [lon, lat] as const) : [...input, first].map(([lon, lat]) => [lon, lat] as const);
  for (let i = 1; i < ring.length; i++) {
    if (ring[i]![0] === ring[i - 1]![0] && ring[i]![1] === ring[i - 1]![1]) {
      return fail(`polygon has a zero-length edge at position ${i}`);
    }
  }
  const vertices = ring.length - 1;
  if (vertices < POLYGON_MIN_VERTICES || vertices > POLYGON_MAX_VERTICES) {
    return fail(`polygon needs ${POLYGON_MIN_VERTICES} to ${POLYGON_MAX_VERTICES} vertices`);
  }
  const lons = ring.map(([lon]) => lon);
  if (Math.max(...lons) - Math.min(...lons) >= 180) {
    return fail("polygon must not cross the antimeridian (longitude span under 180°)");
  }
  const mean = vertexMean(ring);
  if (selfIntersects(projectRing(ring, mean))) return fail("polygon edges must not cross or touch");
  const areaM2 = polygonAreaM2(ring, mean);
  if (areaM2 < POLYGON_MIN_AREA_M2) return fail(`polygon area must be at least ${POLYGON_MIN_AREA_M2} m²`);
  const centroid = polygonCentroid(ring);
  const radius = circumradiusM(ring, centroid);
  if (radius > POLYGON_MAX_CIRCUMRADIUS_M) {
    return fail(`polygon must fit within ${POLYGON_MAX_CIRCUMRADIUS_M / 1000} km of its centroid`);
  }
  return { ok: true, polygon: { ring, centroid, circumradiusM: radius, areaM2 } };
}
