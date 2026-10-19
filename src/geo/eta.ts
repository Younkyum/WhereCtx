/**
 * What an ETA answer may say, and to whom. Pure functions over a route the
 * provider returned; GeoService decides who the caller is.
 *
 * The owner gets the route as the provider gave it. An agent gets an answer
 * that cannot be worked back to where the person is:
 * - times and distance in coarse steps (5 minutes, whole kilometres), no
 *   fares (a taxi fare is the distance), the arrival rounded to 5 minutes;
 * - main roads only, without any road that runs within
 *   AGENT_ROAD_CLEARANCE_M of the origin or of a registered place it routes
 *   to, without side streets (…번길, …로12길), and without any road whose
 *   geometry the provider did not give;
 * - turn-by-turn steps, which name the street the route starts on, only
 *   when the agent may read the precise location anyway.
 */

import { haversineMeters } from "../geofence/distance.js";
import type { Place, PresenceStatus } from "../types.js";
import type { FreshnessView } from "../presence/freshness.js";
import { mainRoads } from "./roads.js";
import type { LatLon, RouteResult, RouteRoad } from "./types.js";

/** No road an agent is told about runs closer than this to the origin or a registered destination. */
export const AGENT_ROAD_CLEARANCE_M = 1500;
/** An agent's minutes and arrival time are rounded to this. */
export const AGENT_TIME_STEP_MIN = 5;

/** A side street: a numbered branch of a road (판교역로241번길, 테헤란로12길, 문형산안길1번길). */
const SIDE_STREET = /\d+번?길$/;

/** Statuses that place the person inside a registered place. */
const INSIDE_PLACE: ReadonlySet<PresenceStatus> = new Set(["home", "work", "custom"]);

/**
 * Whether a reading is fresh enough to time a route from: reported recently
 * while out, or quiet while inside a registered place (a phone at rest
 * there reports rarely, and the place is where the route starts).
 */
export function freshEnoughToRoute(fresh: FreshnessView, status: PresenceStatus): boolean {
  return fresh.freshness === "live" || (fresh.freshness === "stationary" && INSIDE_PLACE.has(status));
}

/** The home place the point is at or near (within its radius times `nearMultiplier`), nearest first. */
export function nearHomePlace(point: LatLon, places: readonly Place[], nearMultiplier: number): Place | null {
  let best: { place: Place; d: number } | null = null;
  for (const place of places) {
    if (place.type !== "home") continue;
    const d = haversineMeters(point.lat, point.lon, place.lat, place.lon);
    if (d <= place.radiusM * nearMultiplier && (!best || d < best.d)) best = { place, d };
  }
  return best?.place ?? null;
}

/** Whether every point of the road is farther than AGENT_ROAD_CLEARANCE_M from every point in `avoid`. */
function clearOf(road: RouteRoad, avoid: readonly LatLon[]): boolean {
  return (
    road.path.length > 0 &&
    road.path.every((p) => avoid.every((a) => haversineMeters(p.lat, p.lon, a.lat, a.lon) > AGENT_ROAD_CLEARANCE_M))
  );
}

/** The main roads an agent may be told: none near `avoid`, no side streets, none of unknown whereabouts. */
export function agentRoads(roads: readonly RouteRoad[], avoid: readonly LatLon[]): string[] {
  return mainRoads(roads.filter((r) => !SIDE_STREET.test(r.name.trim()) && clearOf(r, avoid)));
}

const stepMs = AGENT_TIME_STEP_MIN * 60_000;

/** The numbers an agent is told: minutes in 5-minute steps (at least 5), whole kilometres (at least 1), arrival to 5 minutes. */
export function agentNumbers(route: Pick<RouteResult, "durationSec" | "distanceM" | "departAt">): {
  durationMin: number;
  distanceKm: number;
  arriveAt: string;
} {
  const durationMin = Math.max(AGENT_TIME_STEP_MIN, Math.round(route.durationSec / 60 / AGENT_TIME_STEP_MIN) * AGENT_TIME_STEP_MIN);
  const arrive = Date.parse(route.departAt) + route.durationSec * 1000;
  return {
    durationMin,
    distanceKm: Math.max(1, Math.round(route.distanceM / 1000)),
    arriveAt: new Date(Math.round(arrive / stepMs) * stepMs).toISOString(),
  };
}

/** The numbers the owner is told, as the provider gave them. */
export function ownerNumbers(route: Pick<RouteResult, "durationSec" | "distanceM" | "departAt">): {
  durationMin: number;
  distanceKm: number;
  arriveAt: string;
} {
  return {
    durationMin: Math.max(1, Math.round(route.durationSec / 60)),
    distanceKm: Math.round(route.distanceM / 100) / 10,
    arriveAt: new Date(Date.parse(route.departAt) + route.durationSec * 1000).toISOString(),
  };
}
