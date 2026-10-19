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
 *   when the agent may read the precise location anyway;
 * - for transit, the transfers, the walking minutes in 5-minute steps and
 *   the lines ridden, never a stop name (the first and last stops are the
 *   origin's and the destination's), and without any ride that runs within
 *   AGENT_ROAD_CLEARANCE_M of the origin or a registered destination unless
 *   the agent may read the precise location;
 * - for walking and cycling, no street at all unless the agent may read the
 *   precise location (and asked for the steps).
 */

import { haversineMeters } from "../geofence/distance.js";
import type { Place, PresenceStatus } from "../types.js";
import type { FreshnessView } from "../presence/freshness.js";
import { mainRoads } from "./roads.js";
import type { LatLon, RouteResult, TransitLeg } from "./types.js";

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

/** Whether a stretch has geometry and every point of it is farther than AGENT_ROAD_CLEARANCE_M from every point in `avoid`. */
function clearOf(stretch: { path: readonly LatLon[] }, avoid: readonly LatLon[]): boolean {
  return (
    stretch.path.length > 0 &&
    stretch.path.every((p) => avoid.every((a) => haversineMeters(p.lat, p.lon, a.lat, a.lon) > AGENT_ROAD_CLEARANCE_M))
  );
}

/** The main roads an agent may be told: none near `avoid`, no side streets, none of unknown whereabouts. */
export function agentRoads(roads: Extract<RouteResult, { mode: "car" }>["roads"], avoid: readonly LatLon[]): string[] {
  return mainRoads(roads.filter((r) => !SIDE_STREET.test(r.name.trim()) && clearOf(r, avoid)));
}

/**
 * The lines an agent may be told, in the order ridden: every ride's lines
 * when it may read the precise location, else only rides that board,
 * alight and run farther than AGENT_ROAD_CLEARANCE_M from every point in
 * `avoid`, and never a ride of unknown whereabouts.
 */
export function agentLines(legs: readonly TransitLeg[], avoid: readonly LatLon[], precise: boolean): string[] {
  const rides = legs.filter((l) => l.kind !== "walk" && (precise || clearOf(l, avoid)));
  return [...new Set(rides.flatMap((l) => l.lines))];
}

/** Seconds as an agent's minutes: none stays none, anything else in 5-minute steps, at least 5. */
export function agentMinutes(sec: number): number {
  if (sec <= 0) return 0;
  return Math.max(AGENT_TIME_STEP_MIN, Math.round(sec / 60 / AGENT_TIME_STEP_MIN) * AGENT_TIME_STEP_MIN);
}

/** Seconds on foot across a transit route's walks. */
export function walkingSec(legs: readonly TransitLeg[]): number {
  return legs.filter((l) => l.kind === "walk").reduce((sum, l) => sum + l.durationSec, 0);
}

export const STEPS_NEED_PRECISE =
  "turn-by-turn steps name the streets around the person; they need precise access (read_precise_location, allowed by the person, and a reason)";
export const TRANSIT_STEPS_WITHHELD = "transit steps name the stops around the person and the destination; agents are never told stops";

/**
 * What an agent is told about a route beyond its numbers, by mode, and
 * whether that rests on its precise access.
 */
export function agentDetail(
  route: RouteResult,
  avoid: readonly LatLon[],
  access: { precise: boolean; directions: boolean },
): {
  detail: { summary: string[]; steps?: string[]; stepsWithheld?: string; transfers?: number; walkMin?: number };
  usedPrecise: boolean;
} {
  const { precise, directions } = access;
  switch (route.mode) {
    case "car":
    case "walk":
    case "bike": {
      const summary = route.mode === "car" ? agentRoads(route.roads, avoid) : [];
      const all = route.mode === "car" ? route.steps : route.steps.map((s) => s.guidance).filter(Boolean);
      if (!directions) return { detail: { summary }, usedPrecise: false };
      return precise
        ? { detail: { summary, steps: all }, usedPrecise: true }
        : { detail: { summary, stepsWithheld: STEPS_NEED_PRECISE }, usedPrecise: false };
    }
    case "transit":
      return {
        detail: {
          summary: agentLines(route.legs, avoid, precise),
          transfers: route.transfers,
          walkMin: agentMinutes(walkingSec(route.legs)),
          ...(directions ? { stepsWithheld: TRANSIT_STEPS_WITHHELD } : {}),
        },
        usedPrecise: precise,
      };
  }
}

const stepMs = AGENT_TIME_STEP_MIN * 60_000;

/** The numbers an agent is told: minutes in 5-minute steps (at least 5), whole kilometres (at least 1), arrival to 5 minutes. */
export function agentNumbers(route: Pick<RouteResult, "durationSec" | "distanceM" | "departAt">): {
  durationMin: number;
  distanceKm: number;
  arriveAt: string;
} {
  const durationMin = Math.max(AGENT_TIME_STEP_MIN, agentMinutes(route.durationSec));
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

/** A transit leg as the owner sees it: every stop, every line, and where it runs. */
export interface OwnerLeg {
  kind: TransitLeg["kind"];
  durationMin: number;
  distanceM: number;
  lines: string[];
  stops: string[];
  path: LatLon[];
}

/** What the owner is told about a route beyond its numbers: everything the provider said, by mode. */
export function ownerDetail(route: RouteResult): {
  summary: string[];
  steps: string[];
  tollFare?: number;
  taxiFare?: number;
  fare?: number;
  transfers?: number;
  walkMin?: number;
  legs?: OwnerLeg[];
} {
  switch (route.mode) {
    case "car":
      return {
        summary: mainRoads(route.roads),
        steps: route.steps,
        ...(route.tollFare !== undefined ? { tollFare: route.tollFare } : {}),
        ...(route.taxiFare !== undefined ? { taxiFare: route.taxiFare } : {}),
      };
    case "walk":
    case "bike":
      return { summary: [], steps: route.steps.map((s) => s.guidance).filter(Boolean) };
    case "transit":
      return {
        summary: [...new Set(route.legs.flatMap((l) => l.lines))],
        steps: route.legs.map((l) => l.guidance).filter(Boolean),
        ...(route.fare !== undefined ? { fare: route.fare } : {}),
        transfers: route.transfers,
        walkMin: Math.round(walkingSec(route.legs) / 60),
        legs: route.legs.map((l) => ({
          kind: l.kind,
          durationMin: Math.round(l.durationSec / 60),
          distanceM: l.distanceM,
          lines: l.lines,
          stops: l.stops,
          path: l.path,
        })),
      };
  }
}
