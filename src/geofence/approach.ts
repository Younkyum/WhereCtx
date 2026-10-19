/**
 * Approach detection: `presence.approaching_place` fires once as readings
 * head into a place's approach ring (approachM meters outward from its
 * boundary), and re-arms only after they go back out past 1.1 x approachM.
 * Pure; the presence service persists the approached set and runs this on
 * readings only, never on a sweep or a place change.
 */

import type { Place } from "../types.js";
import { measurePlace } from "./shape.js";

/** Moving toward the place: the edge distance must shrink by at least this much, or the fix's accuracy. */
export const APPROACH_MIN_PROGRESS_M = 25;
/** The approach re-arms once readings are this many approach widths from the boundary. */
export const APPROACH_REARM_FACTOR = 1.1;

export interface ApproachInput {
  places: readonly Place[];
  /** Names approaching already fired for and that have not re-armed. */
  approached: readonly string[];
  /** The previous stored position, if any. */
  prev: { lat: number; lon: number } | undefined;
  now: { lat: number; lon: number; accuracyM?: number };
  /** The confirmed place and the pending-enter candidate after this reading's dwell step. */
  confirmed: string | null;
  candidate: string | null;
}

/** The places to fire approaching for, and the approached set to keep. */
export function approach(input: ApproachInput): { fired: Place[]; approached: string[] } {
  const edge = (place: Place, at: { lat: number; lon: number }): number =>
    measurePlace(place, at.lat, at.lon, 1).edgeDistanceM;
  const byName = new Map(input.places.map((p) => [p.name, p]));

  const approached = input.approached.filter((name) => {
    const place = byName.get(name);
    return place?.approachM != null && edge(place, input.now) <= place.approachM * APPROACH_REARM_FACTOR;
  });

  const fired: Place[] = [];
  const prev = input.prev;
  if (prev) {
    const progressNeeded = Math.max(APPROACH_MIN_PROGRESS_M, input.now.accuracyM ?? 0);
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
