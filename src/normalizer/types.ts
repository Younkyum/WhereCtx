/**
 * The normalized reading produced by every ingest adapter. Downstream
 * components (geofence, store, privacy) consume this shape only — never the
 * raw source-specific payloads (plan section 9.2).
 */

import type { BatteryInfo, IngestSource, Motion, PreciseLocation } from "../types.js";

export interface NormalizedReading {
  precise: PreciseLocation; // lat/lon required; other fields optional
  motion?: Motion;
  battery?: BatteryInfo;
  source: IngestSource;
  /** Device-reported time of the reading, ISO-8601. */
  updatedAt: string;
}

/** Thrown by adapters when a payload cannot be normalized. */
export class NormalizeError extends Error {
  override readonly name = "NormalizeError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Derive a coarse motion class from speed when an adapter does not provide one.
 * Thresholds (m/s): <0.5 stationary, <2.0 walking (~7 km/h), <4.0 running
 * (~14 km/h), otherwise driving. Heuristic only; explicit motion always wins.
 */
export function deriveMotion(speedMps: number | undefined): Motion | undefined {
  if (speedMps === undefined || !Number.isFinite(speedMps) || speedMps < 0) {
    return undefined;
  }
  if (speedMps < 0.5) return "stationary";
  if (speedMps < 2.0) return "walking";
  if (speedMps < 4.0) return "running";
  return "driving";
}

/**
 * Normalize a battery level that may arrive as a 0..1 fraction or a 0..100
 * percentage into a 0..100 integer-ish percentage. Returns undefined for
 * non-finite input.
 */
export function normalizeBatteryLevel(raw: number | undefined): number | undefined {
  if (raw === undefined || !Number.isFinite(raw)) return undefined;
  const pct = raw <= 1 ? raw * 100 : raw;
  return Math.max(0, Math.min(100, Math.round(pct)));
}
