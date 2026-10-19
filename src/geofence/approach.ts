/**
 * Approach detection: `presence.approaching_place` fires once as readings
 * head into a place's approach ring (approachM meters outward from its
 * boundary), and re-arms only after they go back out past the ring by a
 * margin. Pure; the presence service persists the approached set and runs
 * this on readings only, never on a sweep or a place change.
 */

import type { Motion, Place } from "../types.js";
import { measurePlace } from "./shape.js";

/** Moving toward the place: the edge distance must shrink by at least this much, or either fix's accuracy. */
export const APPROACH_MIN_PROGRESS_M = 25;
/** Progress counts only against a previous reading received at most this long before. */
export const APPROACH_MAX_GAP_MS = 10 * 60_000;
/** The approach re-arms past approachM plus this share of it, and at least APPROACH_REARM_MIN_M. */
export const APPROACH_REARM_FACTOR = 0.1;
export const APPROACH_REARM_MIN_M = 50;

interface Fix {
  lat: number;
  lon: number;
  accuracyM?: number;
}

export interface ApproachInput {
  places: readonly Place[];
  /** Names approaching already fired for and that have not re-armed. */
  approached: readonly string[];
  /** The previous stored reading, if any, and when the server received it. */
  prev: (Fix & { receivedAt: string }) | undefined;
  now: Fix & { motion?: Motion };
  /** When the server received `now`. */
  at: Date;
  /** The confirmed place and the pending-enter candidate after this reading's dwell step. */
  confirmed: string | null;
  candidate: string | null;
}

const rearmM = (approachM: number): number =>
  approachM + Math.max(APPROACH_REARM_FACTOR * approachM, APPROACH_REARM_MIN_M);

/** The places to fire approaching for, and the approached set to keep. */
export function approach(input: ApproachInput): { fired: Place[]; approached: string[] } {
  const edge = (place: Place, at: Fix): number => measurePlace(place, at.lat, at.lon, 1).edgeDistanceM;
  const byName = new Map(input.places.map((p) => [p.name, p]));

  const approached = input.approached.filter((name) => {
    const place = byName.get(name);
    return place?.approachM != null && edge(place, input.now) <= rearmM(place.approachM);
  });

  const fired: Place[] = [];
  const prev = input.prev;
  const heading =
    prev !== undefined &&
    input.now.motion !== "stationary" &&
    input.at.getTime() - Date.parse(prev.receivedAt) <= APPROACH_MAX_GAP_MS;
  if (heading) {
    const progressNeeded = Math.max(APPROACH_MIN_PROGRESS_M, input.now.accuracyM ?? 0, prev.accuracyM ?? 0);
    for (const place of input.places) {
      if (place.approachM === null || !place.emits.includes("presence.approaching_place")) continue;
      if (place.name === input.confirmed || place.name === input.candidate || approached.includes(place.name)) continue;
      const now = edge(place, input.now);
      if (now <= 0 || now > place.approachM) continue;
      if (edge(place, prev) - now < progressNeeded) continue;
      fired.push(place);
      approached.push(place.name);
    }
  }
  return { fired, approached };
}
