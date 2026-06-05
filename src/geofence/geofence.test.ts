import { describe, expect, it } from "vitest";
import type { Place } from "../types.js";
import { haversineMeters, encodeGeohash, isValidCoordinate } from "./distance.js";
import { computeGeofence, labelForStatus } from "./engine.js";

const place = (over: Partial<Place>): Place => ({
  id: "p1",
  name: "home",
  lat: 37.0,
  lon: 127.0,
  radiusM: 150,
  type: "home",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("haversineMeters", () => {
  it("is ~0 for identical points", () => {
    expect(haversineMeters(37, 127, 37, 127)).toBeCloseTo(0, 5);
  });

  it("≈111km for one degree of latitude", () => {
    const d = haversineMeters(37, 127, 38, 127);
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });
});

describe("isValidCoordinate", () => {
  it("rejects out-of-range and non-finite", () => {
    expect(isValidCoordinate(91, 0)).toBe(false);
    expect(isValidCoordinate(0, 181)).toBe(false);
    expect(isValidCoordinate(Number.NaN, 0)).toBe(false);
    expect(isValidCoordinate(37, 127)).toBe(true);
  });
});

describe("encodeGeohash", () => {
  it("produces a precision-6 hash by default", () => {
    expect(encodeGeohash(37.0, 127.0)).toHaveLength(6);
  });
});

describe("computeGeofence", () => {
  const nearMult = 3;

  it("returns unknown with no places", () => {
    expect(computeGeofence(37, 127, [], nearMult).status).toBe("unknown");
  });

  it("returns unknown for invalid coordinates", () => {
    expect(computeGeofence(999, 127, [place({})], nearMult).status).toBe("unknown");
  });

  it("detects being inside the home place", () => {
    const r = computeGeofence(37.0, 127.0, [place({})], nearMult);
    expect(r.status).toBe("home");
    expect(r.matchedPlace?.name).toBe("home");
  });

  it("detects near_home just outside the radius but within near band", () => {
    // ~300m north: outside 150m radius, inside 450m near band.
    const r = computeGeofence(37.0027, 127.0, [place({})], nearMult);
    expect(r.status).toBe("near_home");
    expect(r.matchedPlace).toBeUndefined();
  });

  it("returns away when far from all places", () => {
    const r = computeGeofence(37.05, 127.0, [place({})], nearMult);
    expect(r.status).toBe("away");
  });

  it("maps work places to work/near_work", () => {
    const work = place({ name: "work", type: "work", lat: 37.5, lon: 127.5 });
    expect(computeGeofence(37.5, 127.5, [work], nearMult).status).toBe("work");
    expect(computeGeofence(37.5027, 127.5, [work], nearMult).status).toBe("near_work");
  });

  it("uses a custom place's name as label and never returns near_custom", () => {
    const cafe = place({ name: "cafe", type: "custom", label: "My Cafe" });
    expect(computeGeofence(37.0, 127.0, [cafe], nearMult).label).toBe("My Cafe");
    // Just outside a custom place is away, not a near_* status.
    expect(computeGeofence(37.0027, 127.0, [cafe], nearMult).status).toBe("away");
  });

  it("picks the closest containing place when several overlap", () => {
    const home = place({ name: "home", type: "home", lat: 37.0, lon: 127.0, radiusM: 500 });
    const cafe = place({ name: "cafe", type: "custom", lat: 37.001, lon: 127.0, radiusM: 500 });
    const r = computeGeofence(37.0009, 127.0, [home, cafe], nearMult);
    expect(r.matchedPlace?.name).toBe("cafe");
    expect(r.status).toBe("custom");
  });
});

describe("labelForStatus", () => {
  it("maps near_home to a friendly label", () => {
    expect(labelForStatus("near_home")).toBe("near home");
    expect(labelForStatus("transit")).toBe("in transit");
  });
});
