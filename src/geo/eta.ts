/**
 * What an ETA answer may say, and to whom. Pure functions over a route the
 * provider returned; GeoService decides who the caller is.
 *
 * The owner gets the route as the provider gave it. An agent gets an answer
 * that cannot be worked back to where the person is:
 * - the departure floored to 5 minutes, the minutes in 5-minute steps (15
 *   on foot or by bicycle, from 15 on), the arrival as that departure plus
 *   those minutes, whole kilometres, no fares (a taxi fare is the distance);
 * - nothing named that runs within AGENT_ROAD_CLEARANCE_M of the start, the
 *   destination or any registered place as drawn (clearance.ts), measured
 *   along every segment;
 * - by car, main roads only, without side streets (…번길, …로12길) and
 *   without any road whose geometry the provider did not give;
 * - by transit, one line per ride and only when every ride may be named
 *   (agentLines), the transfers only beside them, the walking minutes in
 *   5-minute steps, never a stop;
 * - on foot or by bicycle, no street;
 * - steps (turn-by-turn, or a transit route's legs, which name stations),
 *   at most AGENT_STEPS_MAX, only to an agent that asked and may read the
 *   precise location anyway.
 */

import type { PresenceStatus } from "../types.js";
import type { FreshnessView } from "../presence/freshness.js";
import { isDeepStrictEqual } from "node:util";
import { clearOf, type Keepout } from "./clearance.js";
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

const clear = (stretch: { path: readonly LatLon[] }, avoid: readonly Keepout[]): boolean => clearOf(stretch.path, avoid, AGENT_ROAD_CLEARANCE_M);

/** The main roads an agent may be told: none near `avoid`, no side streets, none of unknown whereabouts. */
export function agentRoads(roads: Extract<RouteResult, { mode: "car" }>["roads"], avoid: readonly Keepout[]): string[] {
  return mainRoads(roads.filter((r) => !SIDE_STREET.test(r.name.trim()) && clear(r, avoid)));
}

/**
 * The line labels an agent may hear without precise access: numbered buses
 * of a citywide kind (간선, 지선, 광역, 직행, 순환, 급행, 공항), numbered
 * subway lines, and rail lines named for no one neighbourhood. A village
 * bus (마을 서초09) or a label that starts with a place name says where.
 */
const OPEN_LINE = /^(?:(?:간선|지선|광역|직행|순환|급행|공항)\s?\d+(?:-\d+)?|\d+호선)$/;
const OPEN_RAIL: ReadonlySet<string> = new Set([
  "신분당선",
  "경의중앙선",
  "수인분당선",
  "공항철도",
  "경춘선",
  "우이신설선",
  "김포골드라인",
  "신림선",
  "GTX-A",
]);

export const openLine = (label: string): boolean => OPEN_LINE.test(label) || OPEN_RAIL.has(label);

/**
 * The lines an agent may be told, one per ride (the first the provider
 * lists, never the alternatives), in the order ridden. With precise access,
 * every bus and subway ride's line. Without it, all or nothing: every ride
 * must be a bus or subway with an open label (openLine) that runs farther
 * than AGENT_ROAD_CLEARANCE_M from every keep-out, else no line at all, so
 * the rides left out cannot be read from the ones named.
 */
export function agentLines(legs: readonly TransitLeg[], avoid: readonly Keepout[], precise: boolean): string[] {
  const rides = legs.filter((l) => l.kind !== "walk");
  if (precise) return rides.flatMap((l) => (l.kind !== "other" && l.lines[0] ? [l.lines[0]] : []));
  const named = rides.map((l) => (l.kind !== "other" && l.lines[0] && openLine(l.lines[0]) && clear(l, avoid) ? l.lines[0] : null));
  return named.every((n) => n !== null) ? (named as string[]) : [];
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
export const TRANSIT_STEPS_NEED_PRECISE =
  "transit steps name the stops and stations around the person and the destination; they need precise access (read_precise_location, allowed by the person, and a reason)";
/** At most this many steps go to an agent. */
export const AGENT_STEPS_MAX = 30;

type AgentAccess = { precise: boolean; directions: boolean };

export interface AgentDetail {
  summary: string[];
  steps?: string[];
  stepsWithheld?: string;
  transfers?: number;
  walkMin?: number;
}

/** The steps, when asked for: the first AGENT_STEPS_MAX with precise access, else why not. */
function stepsFor(steps: readonly string[], { precise, directions }: AgentAccess, withheld: string): Pick<AgentDetail, "steps" | "stepsWithheld"> {
  if (!directions) return {};
  return precise ? { steps: steps.slice(0, AGENT_STEPS_MAX) } : { stepsWithheld: withheld };
}

function detailFor(route: RouteResult, avoid: readonly Keepout[], access: AgentAccess): AgentDetail {
  switch (route.mode) {
    case "car":
      return { summary: agentRoads(route.roads, avoid), ...stepsFor(route.steps, access, STEPS_NEED_PRECISE) };
    case "walk":
    case "bike":
      return { summary: [], ...stepsFor(route.steps.map((s) => s.guidance).filter(Boolean), access, STEPS_NEED_PRECISE) };
    case "transit": {
      const summary = agentLines(route.legs, avoid, access.precise);
      const rides = route.legs.filter((l) => l.kind !== "walk").length;
      return {
        summary,
        // Only beside named lines, where it is their count less one and says nothing more.
        ...(summary.length > 0 ? { transfers: rides - 1 } : {}),
        walkMin: agentMinutes(walkingSec(route.legs)),
        ...stepsFor(route.legs.map((l) => l.guidance).filter(Boolean), access, TRANSIT_STEPS_NEED_PRECISE),
      };
    }
  }
}

/**
 * What an agent is told about a route beyond its numbers, and whether that
 * rests on its precise access: true only when it hears more than an agent
 * without precise access would (a line, a transfer count or a step).
 */
export function agentDetail(route: RouteResult, avoid: readonly Keepout[], access: AgentAccess): { detail: AgentDetail; usedPrecise: boolean } {
  const open = detailFor(route, avoid, { ...access, precise: false });
  if (!access.precise) return { detail: open, usedPrecise: false };
  const detail = detailFor(route, avoid, access);
  const usedPrecise =
    (detail.steps?.length ?? 0) > 0 || detail.transfers !== open.transfers || !isDeepStrictEqual(detail.summary, open.summary);
  return { detail, usedPrecise };
}

/** On foot or by bicycle, an agent hears minutes past this in steps of the same size. */
export const AGENT_ACTIVE_STEP_MIN = 15;

const stepMs = AGENT_TIME_STEP_MIN * 60_000;

/**
 * The numbers an agent is told. The departure is floored to 5 minutes and
 * the arrival is that departure plus the rounded minutes, never worked out
 * from the exact values, so no pair of fields says more than a step. By
 * car or transit, minutes in 5-minute steps (at least 5); on foot or by
 * bicycle, in 15-minute steps from 15 on, since its minutes are its
 * distance. Whole kilometres, at least 1.
 */
export function agentNumbers(route: Pick<RouteResult, "mode" | "durationSec" | "distanceM" | "departAt">): {
  departAt: string;
  durationMin: number;
  distanceKm: number;
  arriveAt: string;
} {
  const minutes = route.durationSec / 60;
  const step = (route.mode === "walk" || route.mode === "bike") && minutes >= AGENT_ACTIVE_STEP_MIN ? AGENT_ACTIVE_STEP_MIN : AGENT_TIME_STEP_MIN;
  const durationMin = Math.max(AGENT_TIME_STEP_MIN, Math.round(minutes / step) * step);
  const departMs = Math.floor(Date.parse(route.departAt) / stepMs) * stepMs;
  return {
    departAt: new Date(departMs).toISOString(),
    durationMin,
    distanceKm: Math.max(1, Math.round(route.distanceM / 1000)),
    arriveAt: new Date(departMs + durationMin * 60_000).toISOString(),
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
