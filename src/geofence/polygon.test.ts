import { describe, expect, it } from "vitest";
import { DEFAULT_PLACE_RULES, type Place } from "../types.js";
import { computeGeofence } from "./engine.js";
import { validatePolygon, type ValidPolygon } from "./polygon.js";
import { measurePlace } from "./shape.js";

const ORIGIN = { lat: 37.5, lon: 127.0 };
const M_PER_DEG_LAT = 111_195;
const mPerDegLon = M_PER_DEG_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180);

/** [lon, lat] of a point `x` m east and `y` m north of ORIGIN. */
const at = (x: number, y: number): [number, number] => [ORIGIN.lon + x / mPerDegLon, ORIGIN.lat + y / M_PER_DEG_LAT];
const ringOf = (pts: Array<[number, number]>): Array<[number, number]> => pts.map(([x, y]) => at(x, y));

function valid(pts: Array<[number, number]>): ValidPolygon {
  const check = validatePolygon(ringOf(pts));
  if (!check.ok) throw new Error(check.error);
  return check.polygon;
}

function polygonPlace(polygon: ValidPolygon, over: Partial<Place> = {}): Place {
  return {
    id: "p1",
    name: "home",
    type: "home",
    lat: polygon.centroid.lat,
    lon: polygon.centroid.lon,
    radiusM: polygon.circumradiusM,
    polygon: polygon.ring,
    ...DEFAULT_PLACE_RULES,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

/** A 300 m square with a 100 m wide notch cut from the top down to y = 100. */
const U: Array<[number, number]> = [
  [0, 0],
  [300, 0],
  [300, 300],
  [200, 300],
  [200, 100],
  [100, 100],
  [100, 300],
  [0, 300],
];

describe("validatePolygon", () => {
  const rejects = (input: ReadonlyArray<readonly [number, number]>, rule: RegExp) => {
    const check = validatePolygon(input);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toMatch(rule);
  };

  it("accepts a concave polygon and closes an open ring", () => {
    const open = ringOf(U);
    const check = validatePolygon(open);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.polygon.ring).toHaveLength(U.length + 1);
    expect(check.polygon.ring[U.length]).toEqual(open[0]);
    // 300 x 300 less the 100 x 200 notch.
    expect(check.polygon.areaM2).toBeGreaterThan(70_000 * 0.99);
    expect(check.polygon.areaM2).toBeLessThan(70_000 * 1.01);
  });

  it("keeps an already closed ring as it is", () => {
    const closed = [...ringOf(U), at(0, 0)];
    const check = validatePolygon(closed);
    expect(check.ok && check.polygon.ring).toHaveLength(closed.length);
  });

  it("rejects a position that is not a coordinate", () => {
    rejects([at(0, 0), [127, 95], at(100, 100)], /not a valid/);
  });

  it("rejects a zero-length edge", () => {
    rejects(ringOf([[0, 0], [100, 0], [100, 0], [100, 100]]), /zero-length edge/);
  });

  it("rejects fewer than 3 or more than 200 vertices", () => {
    rejects(ringOf([[0, 0], [100, 0]]), /3 to 200 vertices/);
    const many = Array.from({ length: 201 }, (_, i): [number, number] => {
      const a = (2 * Math.PI * i) / 201;
      return [1000 * Math.cos(a), 1000 * Math.sin(a)];
    });
    rejects(ringOf(many), /3 to 200 vertices/);
    const most = many.slice(0, 200);
    expect(validatePolygon(ringOf(most)).ok).toBe(true);
  });

  it("rejects a ring spanning the antimeridian", () => {
    rejects(
      [
        [179.9, 10],
        [-179.9, 10],
        [-179.9, 10.1],
        [179.9, 10.1],
      ],
      /antimeridian/,
    );
  });

  it("rejects crossing edges (a bow tie)", () => {
    rejects(ringOf([[0, 0], [100, 100], [100, 0], [0, 100]]), /must not cross/);
  });

  it("rejects a vertex touching another edge", () => {
    rejects(ringOf([[0, 0], [200, 0], [200, 200], [100, 0], [0, 200]]), /must not cross/);
  });

  it("rejects an edge folding back over the previous one", () => {
    rejects(ringOf([[0, 0], [200, 0], [100, 0], [100, 100]]), /must not cross/);
  });

  it("rejects an area under 100 m²", () => {
    rejects(ringOf([[0, 0], [5, 0], [5, 5], [0, 5]]), /at least 100 m²/);
    expect(validatePolygon(ringOf([[0, 0], [11, 0], [11, 11], [0, 11]])).ok).toBe(true);
  });

  it("rejects a polygon reaching more than 100 km from its centroid", () => {
    rejects(ringOf([[0, 0], [150_000, 0], [150_000, 150_000], [0, 150_000]]), /100 km/);
  });
});

describe("measurePlace on a polygon", () => {
  const u = polygonPlace(valid(U));

  it("puts a point in an arm inside and a point in the notch outside", () => {
    const [armLon, armLat] = at(50, 250);
    expect(measurePlace(u, armLat, armLon, 3)).toMatchObject({ inside: true, edgeDistanceM: 0 });
    const [notchLon, notchLat] = at(150, 250);
    const notch = measurePlace(u, notchLat, notchLon, 3);
    expect(notch.inside).toBe(false);
    expect(notch.edgeDistanceM).toBeGreaterThan(49);
    expect(notch.edgeDistanceM).toBeLessThan(51);
  });

  it("counts a point on the boundary as inside", () => {
    const [lon, lat] = at(0, 150);
    expect(measurePlace(u, lat, lon, 3)).toMatchObject({ inside: true, edgeDistanceM: 0 });
  });

  it("measures the distance to the nearest edge from outside", () => {
    const [lon, lat] = at(-80, 150);
    const m = measurePlace(u, lat, lon, 3);
    expect(m.inside).toBe(false);
    expect(m.edgeDistanceM).toBeGreaterThan(79);
    expect(m.edgeDistanceM).toBeLessThan(81);
  });

  it("gives the near band a circle of the same area gets", () => {
    // 100 m square: an equal-area circle has r = 56.4 m, so x3 reaches 112.8 m past it.
    const square = polygonPlace(valid([[0, 0], [100, 0], [100, 100], [0, 100]]));
    const [nearLon, nearLat] = at(50, 100 + 105);
    expect(measurePlace(square, nearLat, nearLon, 3).near).toBe(true);
    const [farLon, farLat] = at(50, 100 + 120);
    expect(measurePlace(square, farLat, farLon, 3).near).toBe(false);
  });

  it("leaves a circle's near band and edge distance as radius arithmetic", () => {
    const circle: Place = { ...u, polygon: undefined, lat: ORIGIN.lat, lon: ORIGIN.lon, radiusM: 100 };
    const [lon, lat] = at(0, 250);
    const m = measurePlace(circle, lat, lon, 3);
    expect(m).toMatchObject({ inside: false, near: true });
    expect(m.edgeDistanceM).toBeGreaterThan(149);
    expect(m.edgeDistanceM).toBeLessThan(151);
  });
});

describe("computeGeofence with a polygon place", () => {
  const u = polygonPlace(valid(U));

  it("is home in an arm and near home in the notch", () => {
    const [armLon, armLat] = at(250, 250);
    expect(computeGeofence(armLat, armLon, [u], 3)).toMatchObject({ status: "home", matchedPlace: { name: "home" } });
    const [notchLon, notchLat] = at(150, 250);
    const notch = computeGeofence(notchLat, notchLon, [u], 3);
    expect(notch.status).toBe("near_home");
    expect(notch.matchedPlace).toBeUndefined();
  });
});
