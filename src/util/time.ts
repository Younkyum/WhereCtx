/**
 * Time helpers. All timestamps in WhereCtx are ISO-8601 strings.
 * `now` is injectable so domain logic and tests stay deterministic.
 */

export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

export function nowIso(clock: Clock = systemClock): string {
  return clock().toISOString();
}

/** Whole seconds elapsed since an ISO timestamp (>= 0; clamps future to 0). */
export function secondsSince(iso: string, clock: Clock = systemClock): number {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 0;
  const diffMs = clock().getTime() - then;
  return Math.max(0, Math.floor(diffMs / 1000));
}

