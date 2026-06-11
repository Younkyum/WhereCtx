/**
 * OwnTracks ingest adapter (plan section 9.2).
 *
 * OwnTracks posts several message types over HTTP. We normalize `_type:
 * "location"` and ignore the rest (transition/waypoint/lwt/...) by returning
 * null, so the ingest endpoint can ack them with an empty array per the
 * OwnTracks HTTP convention.
 *
 * Location field reference:
 *   lat, lon  - degrees (required)
 *   acc       - accuracy, meters
 *   alt       - altitude, meters
 *   vel       - velocity, km/h        -> converted to m/s
 *   cog       - course over ground, degrees
 *   batt      - battery level, percent
 *   bs        - battery status: 0 unknown, 1 unplugged, 2 charging, 3 full
 *   tst       - timestamp, unix seconds
 */

import { z } from "zod";
import { isValidCoordinate } from "../geofence/distance.js";
import { coerceIso } from "./generic.js";
import {
  NormalizeError,
  deriveMotion,
  normalizeBatteryLevel,
  type NormalizedReading,
} from "./types.js";

const OwnTracksSchema = z
  .object({
    _type: z.string().optional(),
    lat: z.number().optional(),
    lon: z.number().optional(),
    acc: z.number().optional(),
    alt: z.number().optional(),
    vel: z.number().optional(),
    cog: z.number().optional(),
    batt: z.number().optional(),
    bs: z.number().optional(),
    tst: z.number().optional(),
  });
// Unknown keys are stripped (zod default; review L1). `_type` stays in the
// schema so non-location OwnTracks messages are still recognized and ignored.

const KMH_TO_MPS = 1 / 3.6;

/**
 * @returns the normalized reading, or `null` if the message is a non-location
 *          OwnTracks type that should be acknowledged but not stored.
 */
export function normalizeOwnTracksPayload(
  payload: unknown,
  fallbackIso: string,
): NormalizedReading | null {
  const parsed = OwnTracksSchema.safeParse(payload);
  if (!parsed.success) {
    throw new NormalizeError(`invalid OwnTracks payload: ${parsed.error.message}`);
  }
  const p = parsed.data;

  // Ignore anything that isn't an explicit location message.
  if (p._type !== undefined && p._type !== "location") {
    return null;
  }

  if (p.lat === undefined || p.lon === undefined) {
    throw new NormalizeError("OwnTracks location missing lat/lon");
  }
  if (!isValidCoordinate(p.lat, p.lon)) {
    throw new NormalizeError(
      `OwnTracks coordinates out of range (lat=${p.lat}, lon=${p.lon})`,
    );
  }

  const speedMps =
    p.vel === undefined || p.vel < 0 ? undefined : p.vel * KMH_TO_MPS;
  const batteryLevel = normalizeBatteryLevel(p.batt);

  return {
    precise: {
      lat: p.lat,
      lon: p.lon,
      accuracyM: p.acc,
      altitudeM: p.alt,
      speedMps,
      headingDeg: p.cog,
    },
    motion: deriveMotion(speedMps),
    battery:
      batteryLevel === undefined
        ? undefined
        : { level: batteryLevel, charging: p.bs === 2 },
    source: "owntracks",
    updatedAt: coerceIso(p.tst, fallbackIso),
  };
}
