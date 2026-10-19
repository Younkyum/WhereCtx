import { describe, expect, it } from "vitest";
import { clearOf, distanceToKeepout, keepouts } from "./clearance.js";
import { AGENT_ROAD_CLEARANCE_M, agentDetail, agentLines } from "./eta.js";
import type { LatLon, TransitLeg, TransitRoute } from "./types.js";

const BASE = { lat: 37.5, lon: 127.0 };
/** A point `east` and `north` kilometres from BASE. */
const km = (east: number, north: number): LatLon => ({
  lat: BASE.lat + north / 111.195,
  lon: BASE.lon + east / (111.195 * Math.cos((BASE.lat * Math.PI) / 180)),
});
const ring = (corners: LatLon[]): Array<[number, number]> => [...corners, corners[0]!].map((p) => [p.lon, p.lat]);
const ride = (lines: string[], path: LatLon[], kind: TransitLeg["kind"] = "bus"): TransitLeg => ({ kind, durationSec: 600, distanceM: 6000, lines, stops: ["a", "b"], guidance: "", path });

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

describe("which lines an agent hears: all or nothing, one per ride, open labels only", () => {
  const origin = km(-20, 0);
  const work = km(20, 0);
  const avoid = keepouts([origin, work], []);
  const clearRide = (lines: string[], kind: TransitLeg["kind"] = "bus") => ride(lines, [km(-5, 5), km(5, 5)], kind);
  const nearStart = ride(["간선 100"], [km(-21, 0.2), km(-15, 0.2)]);
  const walk: TransitLeg = { kind: "walk", durationSec: 300, distanceM: 400, lines: [], stops: [], guidance: "", path: [origin] };
  const route = (legs: TransitLeg[]): TransitRoute => ({ mode: "transit", durationSec: 3600, distanceM: 40_000, path: [], departAt: "2026-10-19T00:00:00.000Z", transfers: legs.length - 1, legs });

  it("names every ride's first line when every ride is clear, with the transfers they imply", () => {
    const legs = [walk, clearRide(["간선 472", "간선 421"]), clearRide(["2호선"], "subway"), clearRide(["신분당선"], "subway"), walk];
    expect(agentLines(legs, avoid, false)).toEqual(["간선 472", "2호선", "신분당선"]);
    expect(agentDetail(route(legs), avoid, { precise: false, directions: false }).detail).toMatchObject({ summary: ["간선 472", "2호선", "신분당선"], transfers: 2 });
  });

  it("one ride near an end hides every line and the transfers", () => {
    const legs = [walk, nearStart, clearRide(["2호선"], "subway"), walk];
    expect(agentLines(legs, avoid, false)).toEqual([]);
    const { detail } = agentDetail(route(legs), avoid, { precise: false, directions: false });
    expect(detail.summary).toEqual([]);
    expect(detail).not.toHaveProperty("transfers");
  });

  it.each([["마을 서초09"], ["서초09"], ["수원1호선"], ["472"], ["간선472번"]])("a label like %s is never named without precise access, nor any line beside it", (label) => {
    expect(agentLines([clearRide([label]), clearRide(["2호선"], "subway")], avoid, false)).toEqual([]);
  });

  it.each([["간선 472"], ["광역9401"], ["공항 6001-1"], ["9호선"], ["GTX-A"], ["경의중앙선"]])("an open label like %s is named", (label) => {
    expect(agentLines([clearRide([label])], avoid, false)).toEqual([label]);
  });

  it("a ride of a kind WhereCtx does not know is never named, and hides the rest", () => {
    expect(agentLines([clearRide(["간선 472"]), clearRide(["Ferry 1"], "other")], avoid, false)).toEqual([]);
    expect(agentLines([clearRide(["간선 472"]), clearRide(["Ferry 1"], "other")], avoid, true)).toEqual(["간선 472"]);
  });

  it("precise access names each ride's first line, near or not, open label or not", () => {
    expect(agentLines([nearStart, clearRide(["마을 서초09", "마을 서초10"])], avoid, true)).toEqual(["간선 100", "마을 서초09"]);
  });
});
