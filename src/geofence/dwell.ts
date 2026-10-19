/**
 * Dwell rules: when the place a reading is inside (the raw verdict) becomes
 * the confirmed place. A pure reducer; the presence service persists its
 * state on the presence row and steps it on every reading, every place
 * change and every dwell sweep.
 *
 * One place is confirmed at a time. Leaving it waits out its exitAfterSec
 * from the first reading outside; entering another waits out that place's
 * enterAfterSec from the first reading inside it. A reading back in the
 * confirmed place cancels both. A reading in another place that is still
 * inside the confirmed one (a place within a place) starts no leave: the
 * other place takes over directly once its enter is confirmed. With every
 * delay 0 a step confirms at once, which is a plain geofence.
 */

export interface DwellState {
  /** The confirmed place. */
  current: string | null;
  /** Since when readings have been outside `current`, while its leave is pending. */
  exitSince: string | null;
  /** The place readings are inside whose enter is pending, and since when. */
  candidate: { name: string; since: string } | null;
}

export const NO_DWELL: DwellState = { current: null, exitSince: null, candidate: null };

export type DwellTransition = { kind: "left" | "entered"; name: string };

export interface DwellDelays {
  enterAfterSec: number;
  exitAfterSec: number;
}

/** The delays of a place by name; undefined for a place that no longer exists. */
export type DelaysFor = (name: string) => DwellDelays | undefined;

/** Where the latest position stands. */
export interface DwellPosition {
  /** The place it is inside (the geofence's pick among overlapping places); null: none. */
  raw: string | null;
  /** It is still inside the confirmed place, whichever place `raw` names. */
  insideCurrent: boolean;
}

export interface StepOptions {
  /** Keep a due enter pending instead of confirming it (the sweep's drive-by guard). */
  holdEnter?: boolean;
}

const elapsedSec = (since: string, now: Date): number => (now.getTime() - Date.parse(since)) / 1000;

/**
 * Step the state with the latest position at `now`. A place that no longer
 * exists leaves at once and is never entered.
 */
export function step(
  state: DwellState,
  { raw, insideCurrent }: DwellPosition,
  now: Date,
  delaysFor: DelaysFor,
  options: StepOptions = {},
): { state: DwellState; transitions: DwellTransition[] } {
  if (raw === state.current) return { state: { current: raw, exitSince: null, candidate: null }, transitions: [] };
  const at = now.toISOString();
  const kept = raw !== null && state.candidate?.name === raw ? state.candidate : null;
  const candidate = raw === null || delaysFor(raw) === undefined ? null : (kept ?? { name: raw, since: at });
  const enterDue =
    candidate !== null && !options.holdEnter && elapsedSec(candidate.since, now) >= delaysFor(candidate.name)!.enterAfterSec;
  const entered = (transitions: DwellTransition[]) => ({
    state: { current: candidate!.name, exitSince: null, candidate: null },
    transitions: [...transitions, { kind: "entered" as const, name: candidate!.name }],
  });

  if (state.current !== null) {
    if (insideCurrent) {
      if (!enterDue) return { state: { current: state.current, exitSince: null, candidate }, transitions: [] };
      return entered([{ kind: "left", name: state.current }]);
    }
    const exitSince = state.exitSince ?? at;
    const exitAfter = delaysFor(state.current)?.exitAfterSec ?? 0;
    if (elapsedSec(exitSince, now) < exitAfter) {
      return { state: { current: state.current, exitSince, candidate }, transitions: [] };
    }
    const left: DwellTransition[] = [{ kind: "left", name: state.current }];
    return enterDue ? entered(left) : { state: { current: null, exitSince: null, candidate }, transitions: left };
  }
  return enterDue ? entered([]) : { state: { current: null, exitSince: null, candidate }, transitions: [] };
}

/** The raw verdict a sweep steps with: no new position, so the one the state was last stepped with. */
export function sweepRaw(state: DwellState): string | null {
  return state.candidate?.name ?? (state.exitSince ? null : state.current);
}

/** Whether a sweep could change the state: an enter or a leave is pending. */
export function isPending(state: DwellState): boolean {
  return state.candidate !== null || state.exitSince !== null;
}

/**
 * The transition under way, for agents: leaving the confirmed place while
 * that is pending (the status still says it), else entering the candidate.
 */
export function pendingTransition(state: DwellState): { kind: "entering" | "leaving"; name: string; since: string } | null {
  if (state.current !== null && state.exitSince) return { kind: "leaving", name: state.current, since: state.exitSince };
  if (state.candidate) return { kind: "entering", ...state.candidate };
  return null;
}
