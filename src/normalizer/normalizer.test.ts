import { describe, expect, it } from "vitest";
import { normalizeGenericPayload } from "./generic.js";
import { normalizeShortcutPayload } from "./shortcut.js";
import { normalizeOwnTracksPayload } from "./owntracks.js";
import { NormalizeError, deriveMotion, normalizeBatteryLevel } from "./types.js";

// Receive-time fallback. Set after the device timestamps used below so the
// future-skew clamp (F11) does not trip on legitimately-past device readings.
const FALLBACK = "2026-06-06T00:00:00.000Z";

describe("deriveMotion", () => {
  it("classifies by speed and ignores garbage", () => {
    expect(deriveMotion(0)).toBe("stationary");
    expect(deriveMotion(1)).toBe("walking");
    expect(deriveMotion(3)).toBe("running");
    expect(deriveMotion(20)).toBe("driving");
    expect(deriveMotion(undefined)).toBeUndefined();
    expect(deriveMotion(-1)).toBeUndefined();
  });
});

describe("normalizeBatteryLevel", () => {
  it("accepts fractions and percentages", () => {
    expect(normalizeBatteryLevel(0.64)).toBe(64);
    expect(normalizeBatteryLevel(64)).toBe(64);
    expect(normalizeBatteryLevel(150)).toBe(100);
    expect(normalizeBatteryLevel(undefined)).toBeUndefined();
  });
});

describe("normalizeGenericPayload", () => {
  it("normalizes a documented payload", () => {
    const r = normalizeGenericPayload(
      { source: "ios_shortcut", lat: 37.1, lon: 127.1, accuracyM: 21, battery: 64, timestamp: "2026-06-05T15:30:00+09:00" },
      FALLBACK,
    );
    expect(r.precise.lat).toBe(37.1);
    expect(r.precise.accuracyM).toBe(21);
    expect(r.battery).toEqual({ level: 64, charging: undefined });
    expect(r.source).toBe("ios_shortcut");
    expect(r.updatedAt).toBe("2026-06-05T06:30:00.000Z");
  });

  it("accepts latitude/longitude aliases and string numbers", () => {
    const r = normalizeGenericPayload({ latitude: "37.5", longitude: "127.5" }, FALLBACK);
    expect(r.precise.lat).toBe(37.5);
    expect(r.precise.lon).toBe(127.5);
    expect(r.source).toBe("manual");
    expect(r.updatedAt).toBe(FALLBACK);
  });

  it("derives motion from speed", () => {
    const r = normalizeGenericPayload({ lat: 1, lon: 1, speed: 20 }, FALLBACK);
    expect(r.motion).toBe("driving");
  });

  it("throws on missing coordinates", () => {
    expect(() => normalizeGenericPayload({ battery: 50 }, FALLBACK)).toThrow(NormalizeError);
  });

  it("throws on out-of-range coordinates", () => {
    expect(() => normalizeGenericPayload({ lat: 99, lon: 0 }, FALLBACK)).toThrow(NormalizeError);
  });

  it("clamps an implausibly-future device timestamp to the receive time (F11)", () => {
    // Fallback is the server receive time; a timestamp an hour ahead is distrusted.
    const future = "2026-06-06T01:00:00.000Z"; // +1h after FALLBACK
    const r = normalizeGenericPayload({ lat: 1, lon: 1, timestamp: future }, FALLBACK);
    expect(r.updatedAt).toBe(FALLBACK);
  });

  it("accepts a slightly-future timestamp within the skew window", () => {
    const slight = "2026-06-06T00:02:00.000Z"; // +2min after FALLBACK, within 5min skew
    const r = normalizeGenericPayload({ lat: 1, lon: 1, timestamp: slight }, FALLBACK);
    expect(r.updatedAt).toBe(slight);
  });
});

describe("normalizeShortcutPayload", () => {
  it("maps Shortcuts-style field names and 0..1 battery", () => {
    const r = normalizeShortcutPayload(
      { Latitude: 37.2, Longitude: 127.2, "Battery Level": 0.5, Altitude: 30 },
      FALLBACK,
    );
    expect(r.precise.lat).toBe(37.2);
    expect(r.precise.altitudeM).toBe(30);
    expect(r.battery?.level).toBe(50);
    expect(r.source).toBe("ios_shortcut");
  });

  it("rejects a non-object payload", () => {
    expect(() => normalizeShortcutPayload("nope", FALLBACK)).toThrow(NormalizeError);
  });
});

describe("normalizeOwnTracksPayload", () => {
  it("normalizes a location message (km/h -> m/s, battery status)", () => {
    const r = normalizeOwnTracksPayload(
      { _type: "location", lat: 37.3, lon: 127.3, acc: 12, vel: 36, cog: 90, batt: 80, bs: 2, tst: 1700000000 },
      FALLBACK,
    );
    expect(r).not.toBeNull();
    expect(r!.precise.speedMps).toBeCloseTo(10, 5);
    expect(r!.motion).toBe("driving");
    expect(r!.battery).toEqual({ level: 80, charging: true });
    expect(r!.precise.headingDeg).toBe(90);
    expect(r!.updatedAt).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it("ignores non-location message types", () => {
    expect(normalizeOwnTracksPayload({ _type: "transition", lat: 1, lon: 1 }, FALLBACK)).toBeNull();
  });

  it("throws when a location message lacks coordinates", () => {
    expect(() => normalizeOwnTracksPayload({ _type: "location" }, FALLBACK)).toThrow(NormalizeError);
  });
});
