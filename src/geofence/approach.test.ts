import { describe, expect, it } from "vitest";
import { DEFAULT_PLACE_RULES, type Place } from "../types.js";
import { approach, type ApproachInput } from "./approach.js";

const CENTER = { lat: 37.5, lon: 127.0 };
const M_PER_DEG_LAT = 111_195;
/** A point `m` meters north of CENTER. */
const north = (m: number) => ({ lat: CENTER.lat + m / M_PER_DEG_LAT, lon: CENTER.lon });
const NOW = new Date("2026-06-05T00:10:00.000Z");
/** The previous reading, `m` meters north, received `agoSec` before NOW. */
const before = (m: number, agoSec = 60, accuracyM?: number) => ({
  ...north(m),
  accuracyM,
  receivedAt: new Date(NOW.getTime() - agoSec * 1000).toISOString(),
});

/** 100 m circle with a 500 m approach ring: the ring spans 100..600 m from the center. */
const gym: Place = {
  id: "g",
  name: "gym",
  type: "custom",
  ...CENTER,
  radiusM: 100,
  ...DEFAULT_PLACE_RULES,
  approachM: 500,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const base = (over: Partial<ApproachInput>): ApproachInput => ({
  places: [gym],
  approached: [],
  prev: before(900),
  now: { ...north(500), motion: "walking" },
  at: NOW,
  confirmed: null,
  candidate: null,
  ...over,
});

const firedNames = (input: ApproachInput) => approach(input).fired.map((p) => p.name);

describe("approach", () => {
  it("fires once when a reading moves into the ring toward the place", () => {
    const first = approach(base({}));
    expect(first.fired.map((p) => p.name)).toEqual(["gym"]);
    expect(first.approached).toEqual(["gym"]);
    const second = approach(base({ approached: first.approached, prev: before(500), now: { ...north(400), motion: "walking" } }));
    expect(second.fired).toEqual([]);
    expect(second.approached).toEqual(["gym"]);
  });

  it("does not fire while moving away inside the ring", () => {
    expect(firedNames(base({ prev: before(300), now: { ...north(500), motion: "walking" } }))).toEqual([]);
  });

  it("re-arms only past 1.1 x the ring width, then fires again", () => {
    // 600 m from the center is 500 m from the edge: inside 1.1 x 500.
    expect(approach(base({ approached: ["gym"], prev: before(400), now: { ...north(640), motion: "walking" } })).approached).toEqual(["gym"]);
    // 700 m from the center is 600 m from the edge: past 550 m.
    const rearmed = approach(base({ approached: ["gym"], prev: before(640), now: { ...north(700), motion: "walking" } }));
    expect(rearmed.approached).toEqual([]);
    expect(firedNames(base({ approached: rearmed.approached, prev: before(700), now: { ...north(450), motion: "walking" } }))).toEqual(["gym"]);
  });

  it("does not fire inside the place, nor for the confirmed or pending place", () => {
    expect(firedNames(base({ prev: before(300), now: { ...north(50), motion: "walking" } }))).toEqual([]);
    expect(firedNames(base({ confirmed: "gym" }))).toEqual([]);
    expect(firedNames(base({ candidate: "gym" }))).toEqual([]);
  });

  it("needs a previous position and progress of at least 25 m or the fix's accuracy", () => {
    expect(firedNames(base({ prev: undefined }))).toEqual([]);
    expect(firedNames(base({ prev: before(520), now: { ...north(500), motion: "walking" } }))).toEqual([]);
    expect(firedNames(base({ prev: before(550), now: { ...north(500), accuracyM: 80, motion: "walking" } }))).toEqual([]);
    expect(firedNames(base({ prev: before(600), now: { ...north(500), accuracyM: 80, motion: "walking" } }))).toEqual(["gym"]);
  });

  it("needs the previous reading to be recent: progress since a reading long ago is not heading in", () => {
    expect(firedNames(base({ prev: before(900, 10 * 60) }))).toEqual(["gym"]);
    expect(firedNames(base({ prev: before(900, 10 * 60 + 1) }))).toEqual([]);
  });

  it("needs progress beyond the previous fix's accuracy too", () => {
    expect(firedNames(base({ prev: before(600, 60, 150) }))).toEqual([]);
    expect(firedNames(base({ prev: before(700, 60, 150) }))).toEqual(["gym"]);
  });

  it("ignores a reading that says it is stationary", () => {
    expect(firedNames(base({ now: { ...north(500), motion: "stationary" } }))).toEqual([]);
  });

  it("re-arms a narrow ring only at least 50 m past it", () => {
    const narrow = { ...gym, approachM: 100 };
    // 120 m from the edge: past 1.1 x 100 m, but within 100 + 50 m.
    expect(approach(base({ places: [narrow], approached: ["gym"], now: { ...north(220), motion: "walking" } })).approached).toEqual(["gym"]);
    expect(approach(base({ places: [narrow], approached: ["gym"], now: { ...north(251), motion: "walking" } })).approached).toEqual([]);
  });

  it("stays off for a place without a ring or that does not emit approaching", () => {
    expect(firedNames(base({ places: [{ ...gym, approachM: null }] }))).toEqual([]);
    expect(firedNames(base({ places: [{ ...gym, emits: ["presence.entered_place"] }] }))).toEqual([]);
  });

  it("drops a deleted place from the approached set", () => {
    expect(approach(base({ places: [], approached: ["gym"] })).approached).toEqual([]);
  });
});
