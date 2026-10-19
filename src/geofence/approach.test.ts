import { describe, expect, it } from "vitest";
import { DEFAULT_PLACE_RULES, type Place } from "../types.js";
import { approach, type ApproachInput } from "./approach.js";

const CENTER = { lat: 37.5, lon: 127.0 };
const M_PER_DEG_LAT = 111_195;
/** A point `m` meters north of CENTER. */
const north = (m: number) => ({ lat: CENTER.lat + m / M_PER_DEG_LAT, lon: CENTER.lon });

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
  prev: north(900),
  now: north(500),
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
    const second = approach(base({ approached: first.approached, prev: north(500), now: north(400) }));
    expect(second.fired).toEqual([]);
    expect(second.approached).toEqual(["gym"]);
  });

  it("does not fire while moving away inside the ring", () => {
    expect(firedNames(base({ prev: north(300), now: north(500) }))).toEqual([]);
  });

  it("re-arms only past 1.1 x the ring width, then fires again", () => {
    // 600 m from the center is 500 m from the edge: inside 1.1 x 500.
    expect(approach(base({ approached: ["gym"], prev: north(400), now: north(640) })).approached).toEqual(["gym"]);
    // 700 m from the center is 600 m from the edge: past 550 m.
    const rearmed = approach(base({ approached: ["gym"], prev: north(640), now: north(700) }));
    expect(rearmed.approached).toEqual([]);
    expect(firedNames(base({ approached: rearmed.approached, prev: north(700), now: north(450) }))).toEqual(["gym"]);
  });

  it("does not fire inside the place, nor for the confirmed or pending place", () => {
    expect(firedNames(base({ prev: north(300), now: north(50) }))).toEqual([]);
    expect(firedNames(base({ confirmed: "gym" }))).toEqual([]);
    expect(firedNames(base({ candidate: "gym" }))).toEqual([]);
  });

  it("needs a previous position and progress of at least 25 m or the fix's accuracy", () => {
    expect(firedNames(base({ prev: undefined }))).toEqual([]);
    expect(firedNames(base({ prev: north(520), now: north(500) }))).toEqual([]);
    expect(firedNames(base({ prev: north(550), now: { ...north(500), accuracyM: 80 } }))).toEqual([]);
    expect(firedNames(base({ prev: north(600), now: { ...north(500), accuracyM: 80 } }))).toEqual(["gym"]);
  });

  it("stays off for a place without a ring or that does not emit approaching", () => {
    expect(firedNames(base({ places: [{ ...gym, approachM: null }] }))).toEqual([]);
    expect(firedNames(base({ places: [{ ...gym, emits: ["presence.entered_place"] }] }))).toEqual([]);
  });

  it("drops a deleted place from the approached set", () => {
    expect(approach(base({ places: [], approached: ["gym"] })).approached).toEqual([]);
  });
});
