/**
 * Generic JSON ingest adapter (plan section 9.1).
 *
 * Accepts the documented payload plus common field aliases so simple HTTP
 * clients and iOS Shortcuts can post with minimal friction:
 *
 *   { "source":"ios_shortcut", "lat":37.1, "lon":127.1, "accuracyM":21,
 *     "battery":64, "timestamp":"2026-06-05T15:30:00+09:00" }
 */

import { z } from "zod";
import type { IngestSource, Motion } from "../types.js";
import { isValidCoordinate } from "../geofence/distance.js";
import {
  NormalizeError,
  deriveMotion,
  normalizeBatteryLevel,
  type NormalizedReading,
} from "./types.js";

const SOURCES: readonly IngestSource[] = [
  "ios_shortcut",
  "mobile_app",
  "owntracks",
  "tasker",
  "home_assistant",
  "manual",
] as const;

const MOTIONS: readonly Motion[] = [
  "stationary",
  "walking",
  "running",
  "driving",
  "transit",
  "unknown",
] as const;

const num = z.union([z.number(), z.string().transform((s) => Number(s))]);

const GenericSchema = z
  .object({
    source: z.string().optional(),
    lat: num.optional(),
    latitude: num.optional(),
    lon: num.optional(),
    lng: num.optional(),
    longitude: num.optional(),
    accuracyM: num.optional(),
    accuracy: num.optional(),
    acc: num.optional(),
    altitudeM: num.optional(),
    altitude: num.optional(),
    speedMps: num.optional(),
    speed: num.optional(),
    headingDeg: num.optional(),
    heading: num.optional(),
    course: num.optional(),
    motion: z.string().optional(),
    battery: num.optional(),
    batteryLevel: num.optional(),
    charging: z.boolean().optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
    time: z.union([z.string(), z.number()]).optional(),
  });
// Unknown keys are stripped (zod default) — they were never read, and not
// carrying them avoids retaining attacker-supplied fields in memory (review L1).

/** Reject device timestamps more than this far in the future (clock skew guard). */
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Coerce a numeric/string/unix timestamp to ISO; `fallback` when absent/invalid.
 *
 * Staleness is a load-bearing safety signal (plan §7.6), and `updatedAt` is
 * device-controlled, so a timestamp implausibly far in the future is clamped to
 * `fallback` (the server receive time) rather than trusted — otherwise a skewed
 * or malicious device could pin presence permanently "fresh" (review F11).
 */
export function coerceIso(ts: string | number | undefined, fallback: string): string {
  if (ts === undefined || ts === "") return fallback;
  let ms: number;
  if (typeof ts === "number") {
    ms = ts >= 1e12 ? ts : ts * 1000; // milliseconds vs seconds
  } else {
    ms = Date.parse(ts);
  }
  if (Number.isNaN(ms)) return fallback;

  const fallbackMs = Date.parse(fallback);
  if (!Number.isNaN(fallbackMs) && ms > fallbackMs + MAX_FUTURE_SKEW_MS) {
    return fallback; // implausibly future -> distrust, use receive time
  }
  return new Date(ms).toISOString();
}

function coerceSource(raw: string | undefined, fallback: IngestSource): IngestSource {
  if (raw && (SOURCES as readonly string[]).includes(raw)) {
    return raw as IngestSource;
  }
  return fallback;
}

function coerceMotion(raw: string | undefined): Motion | undefined {
  if (raw && (MOTIONS as readonly string[]).includes(raw)) {
    return raw as Motion;
  }
  return undefined;
}

const first = (...vals: Array<number | undefined>): number | undefined =>
  vals.find((v) => v !== undefined && Number.isFinite(v));

export function normalizeGenericPayload(
  payload: unknown,
  fallbackIso: string,
  defaultSource: IngestSource = "manual",
): NormalizedReading {
  const parsed = GenericSchema.safeParse(payload);
  if (!parsed.success) {
    throw new NormalizeError(`invalid payload: ${parsed.error.message}`);
  }
  const p = parsed.data;

  const lat = first(p.lat, p.latitude);
  const lon = first(p.lon, p.lng, p.longitude);
  if (lat === undefined || lon === undefined) {
    throw new NormalizeError("missing required coordinates (lat/lon)");
  }
  if (!isValidCoordinate(lat, lon)) {
    throw new NormalizeError(`coordinates out of range (lat=${lat}, lon=${lon})`);
  }

  const speedMps = first(p.speedMps, p.speed);
  const motion = coerceMotion(p.motion) ?? deriveMotion(speedMps);
  const batteryLevel = normalizeBatteryLevel(first(p.battery, p.batteryLevel));

  return {
    precise: {
      lat,
      lon,
      accuracyM: first(p.accuracyM, p.accuracy, p.acc),
      altitudeM: first(p.altitudeM, p.altitude),
      speedMps,
      headingDeg: first(p.headingDeg, p.heading, p.course),
    },
    motion,
    battery:
      batteryLevel === undefined
        ? undefined
        : { level: batteryLevel, charging: p.charging },
    source: coerceSource(p.source, defaultSource),
    updatedAt: coerceIso(p.timestamp ?? p.time, fallbackIso),
  };
}
