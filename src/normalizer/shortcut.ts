/**
 * iOS Shortcut ingest adapter (plan section 9.2).
 *
 * The Apple Shortcuts "Get Current Location" action exposes fields the user
 * wires into a JSON body. We accept the generic shape but default the source to
 * `ios_shortcut` and tolerate Shortcuts' common field names (Latitude/Longitude,
 * Altitude, Battery Level as a 0..1 fraction, etc.).
 */

import { isValidCoordinate } from "../geofence/distance.js";
import { normalizeGenericPayload } from "./generic.js";
import { NormalizeError, type NormalizedReading } from "./types.js";

type Dict = Record<string, unknown>;

/** Lowercase + strip spaces/underscores so "Battery Level" matches "batterylevel". */
function flattenKeys(obj: Dict): Dict {
  const out: Dict = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k.toLowerCase().replace(/[\s_]+/g, "")] = v;
  }
  return out;
}

export function normalizeShortcutPayload(
  payload: unknown,
  fallbackIso: string,
): NormalizedReading {
  if (typeof payload !== "object" || payload === null) {
    throw new NormalizeError("shortcut payload must be a JSON object");
  }
  const flat = flattenKeys(payload as Dict);

  // Map Shortcuts-friendly aliases onto the generic schema's field names.
  const remapped: Dict = {
    source: "ios_shortcut",
    lat: flat.lat ?? flat.latitude,
    lon: flat.lon ?? flat.lng ?? flat.longitude,
    accuracyM: flat.accuracym ?? flat.accuracy ?? flat.horizontalaccuracy,
    altitudeM: flat.altitudem ?? flat.altitude ?? flat.elevation,
    speedMps: flat.speedmps ?? flat.speed,
    headingDeg: flat.headingdeg ?? flat.heading ?? flat.course,
    battery: flat.battery ?? flat.batterylevel,
    charging: flat.charging,
    motion: flat.motion,
    timestamp: flat.timestamp ?? flat.time ?? flat.date,
  };

  const reading = normalizeGenericPayload(remapped, fallbackIso, "ios_shortcut");

  // Guard again with a Shortcut-specific message for clarity.
  if (!isValidCoordinate(reading.precise.lat, reading.precise.lon)) {
    throw new NormalizeError("shortcut payload has invalid coordinates");
  }
  return reading;
}
