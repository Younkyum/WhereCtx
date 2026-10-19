import { describe, expect, it } from "vitest";
import { clearOf, distanceToKeepout, keepouts } from "./clearance.js";
import { AGENT_ROAD_CLEARANCE_M, agentLines } from "./eta.js";
import type { LatLon, TransitLeg } from "./types.js";

const BASE = { lat: 37.5, lon: 127.0 };
/** A point `east` and `north` kilometres from BASE. */
const km = (east: number, north: number): LatLon => ({
  lat: BASE.lat + north / 111.195,
  lon: BASE.lon + east / (111.195 * Math.cos((BASE.lat * Math.PI) / 180)),
});
const ring = (corners: LatLon[]): Array<[number, number]> => [...corners, corners[0]!].map((p) => [p.lon, p.lat]);
const ride = (lines: string[], path: LatLon[]): TransitLeg => ({ kind: "bus", durationSec: 600, distanceM: 6000, lines, stops: ["a", "b"], guidance: "", path });

describe("how near a stretch runs to a keep-out", () => {
  it("measures a segment, not only its ends: a two-point ride 300 m past the start is near", () => {
    const path = [km(-3, 0.3), km(3, 0.3)];
    const d = distanceToKeepout(path, { kind: "disc", at: BASE, radiusM: 0 });
    expect(d).toBeGreaterThan(280);
    expect(d).toBeLessThan(320);
    expect(clearOf(path, keepouts([BASE], []), AGENT_ROAD_CLEARANCE_M)).toBe(false);
  });

  it("a circle place is measured to its edge", () => {
    const d = distanceToKeepout([km(0, -3), km(0, 3)], { kind: "disc", at: km(1, 0), radiusM: 150 });
    expect(d).toBeGreaterThan(830);
    expect(d).toBeLessThan(870);
  });

  it("a polygon place is measured to its outline, however far its centroid", () => {
    const long = { lat: 0, lon: 0, radiusM: 0, polygon: ring([km(0, 0), km(4, 0), km(4, 0.2), km(0, 0.2)]) };
    const path = [km(4.3, -3), km(4.3, 3)];
    const [shape] = keepouts([], [{ ...long, ...km(2, 0.1) }]);
    expect(distanceToKeepout(path, shape!)).toBeLessThan(320);
    expect(distanceToKeepout([km(2, 0.1)], shape!)).toBe(0);
    expect(distanceToKeepout([km(2, -3), km(2, 3)], shape!)).toBe(0);
    expect(clearOf(path, [shape!], AGENT_ROAD_CLEARANCE_M)).toBe(false);
  });

  it("a stretch without geometry is never clear", () => {
    expect(clearOf([], [], AGENT_ROAD_CLEARANCE_M)).toBe(false);
  });
});

describe("the lines an agent is told keep clear of every registered place", () => {
  const origin = km(-10, 0);
  const work = km(10, 0);

  it("a ride whose stops are 2 km clear of the start but which passes 300 m from it is not named", () => {
    const legs = [ride(["간선 472"], [km(-12, 0.3), km(-8, 0.3)])];
    expect(distanceToKeepout(legs[0]!.path.slice(0, 1), { kind: "disc", at: origin, radiusM: 0 })).toBeGreaterThan(1900);
    expect(agentLines(legs, keepouts([origin, work], []), false)).toEqual([]);
  });

  it("a route to work that passes beside home does not name the line", () => {
    const home = { ...km(0, 0.4), radiusM: 150 };
    const legs = [ride(["간선 472"], [km(-5, 0), km(5, 0)])];
    expect(agentLines(legs, keepouts([origin, work], []), false)).toEqual(["간선 472"]);
    expect(agentLines(legs, keepouts([origin, work], [home]), false)).toEqual([]);
  });
});
