import { describe, expect, it } from "vitest";
import { NO_DWELL, pendingTransition, step, sweepRaw, type DelaysFor, type DwellState, type DwellTransition } from "./dwell.js";

const T0 = Date.parse("2026-06-05T00:00:00.000Z");
const at = (sec: number): Date => new Date(T0 + sec * 1000);

const delays =
  (table: Record<string, [enter: number, exit: number]>): DelaysFor =>
  (name) => {
    const d = table[name];
    return d ? { enterAfterSec: d[0], exitAfterSec: d[1] } : undefined;
  };

/** Step through `(sec, raw)` readings from `state`, collecting every transition. */
function run(rules: DelaysFor, readings: Array<[sec: number, raw: string | null]>, state: DwellState = NO_DWELL) {
  const transitions: Array<DwellTransition & { sec: number }> = [];
  for (const [sec, raw] of readings) {
    const next = step(state, raw, at(sec), rules);
    state = next.state;
    transitions.push(...next.transitions.map((t) => ({ ...t, sec })));
  }
  return { state, transitions };
}

describe("dwell step", () => {
  it("confirms at once with no delays, leaving before entering", () => {
    const rules = delays({ A: [0, 0], B: [0, 0] });
    const { state, transitions } = run(rules, [
      [0, "A"],
      [10, "B"],
      [20, null],
    ]);
    expect(transitions).toEqual([
      { kind: "entered", name: "A", sec: 0 },
      { kind: "left", name: "A", sec: 10 },
      { kind: "entered", name: "B", sec: 10 },
      { kind: "left", name: "B", sec: 20 },
    ]);
    expect(state).toEqual(NO_DWELL);
  });

  it("enters only after the place's enter delay", () => {
    const rules = delays({ A: [120, 0] });
    const early = run(rules, [
      [0, "A"],
      [60, "A"],
    ]);
    expect(early.transitions).toEqual([]);
    expect(early.state.candidate).toEqual({ name: "A", since: at(0).toISOString() });
    const later = run(rules, [[120, "A"]], early.state);
    expect(later.transitions).toEqual([{ kind: "entered", name: "A", sec: 120 }]);
    expect(later.state.current).toBe("A");
  });

  it("leaves only after the place's exit delay, counted from the first reading outside", () => {
    const rules = delays({ A: [0, 300] });
    const { state, transitions } = run(rules, [
      [0, "A"],
      [100, null],
      [200, null],
      [399, null],
    ]);
    expect(transitions).toEqual([{ kind: "entered", name: "A", sec: 0 }]);
    expect(state).toMatchObject({ current: "A", exitSince: at(100).toISOString() });
    expect(run(rules, [[400, null]], state).transitions).toEqual([{ kind: "left", name: "A", sec: 400 }]);
  });

  it("cancels a pending leave when a reading comes back inside", () => {
    const rules = delays({ A: [0, 300] });
    const { state, transitions } = run(rules, [
      [0, "A"],
      [100, null],
      [200, "A"],
      [350, null],
      [500, null],
    ]);
    expect(transitions).toEqual([{ kind: "entered", name: "A", sec: 0 }]);
    expect(state.exitSince).toBe(at(350).toISOString());
  });

  it("restarts a pending enter after flapping out of the place", () => {
    const rules = delays({ A: [120, 0] });
    const { state, transitions } = run(rules, [
      [0, "A"],
      [60, null],
      [90, "A"],
      [180, "A"],
    ]);
    expect(transitions).toEqual([]);
    expect(state.candidate?.since).toBe(at(90).toISOString());
    expect(run(rules, [[210, "A"]], state).transitions).toEqual([{ kind: "entered", name: "A", sec: 210 }]);
  });

  it("moves A to B with A's exit delay, then B's enter delay counted from the first reading in B", () => {
    const rules = delays({ A: [0, 60], B: [120, 0] });
    const { transitions } = run(rules, [
      [0, "A"],
      [10, "B"],
      [50, "B"],
      [70, "B"],
      [129, "B"],
      [130, "B"],
    ]);
    expect(transitions).toEqual([
      { kind: "entered", name: "A", sec: 0 },
      { kind: "left", name: "A", sec: 70 },
      { kind: "entered", name: "B", sec: 130 },
    ]);
  });

  it("leaves a deleted confirmed place at once and never enters a deleted candidate", () => {
    const before = run(delays({ A: [0, 600], B: [300, 0] }), [
      [0, "A"],
      [10, "B"],
    ]);
    expect(before.state).toMatchObject({ current: "A", candidate: { name: "B" } });
    const afterDelete = delays({});
    const swept = step(before.state, sweepRaw(before.state), at(20), afterDelete);
    expect(swept.transitions).toEqual([{ kind: "left", name: "A" }]);
    expect(swept.state).toEqual(NO_DWELL);
  });

  it("holds a due enter while told to, and still confirms a due leave", () => {
    const rules = delays({ A: [60, 0], B: [0, 60] });
    const pendingEnter = run(rules, [[0, "A"]]).state;
    const held = step(pendingEnter, sweepRaw(pendingEnter), at(120), rules, { holdEnter: true });
    expect(held.transitions).toEqual([]);
    expect(held.state.candidate?.name).toBe("A");

    const pendingLeave = run(rules, [
      [0, "B"],
      [10, null],
    ]).state;
    const left = step(pendingLeave, sweepRaw(pendingLeave), at(100), rules, { holdEnter: true });
    expect(left.transitions).toEqual([{ kind: "left", name: "B" }]);
  });
});

describe("sweepRaw", () => {
  it("repeats the verdict the state was last stepped with", () => {
    expect(sweepRaw(NO_DWELL)).toBeNull();
    expect(sweepRaw({ current: "A", exitSince: null, candidate: null })).toBe("A");
    expect(sweepRaw({ current: "A", exitSince: at(0).toISOString(), candidate: null })).toBeNull();
    expect(sweepRaw({ current: "A", exitSince: at(0).toISOString(), candidate: { name: "B", since: at(0).toISOString() } })).toBe("B");
    expect(sweepRaw({ current: null, exitSince: null, candidate: { name: "B", since: at(0).toISOString() } })).toBe("B");
  });

  it("confirms a pending enter on a sweep once the delay has passed", () => {
    const rules = delays({ A: [60, 0] });
    const pending = run(rules, [[0, "A"]]).state;
    expect(step(pending, sweepRaw(pending), at(30), rules).transitions).toEqual([]);
    expect(step(pending, sweepRaw(pending), at(60), rules).transitions).toEqual([{ kind: "entered", name: "A" }]);
  });
});

describe("pendingTransition", () => {
  it("names the leave while the confirmed place is still pending, else the enter", () => {
    const since = at(0).toISOString();
    expect(pendingTransition(NO_DWELL)).toBeNull();
    expect(pendingTransition({ current: "A", exitSince: since, candidate: { name: "B", since } })).toEqual({ kind: "leaving", name: "A", since });
    expect(pendingTransition({ current: null, exitSince: null, candidate: { name: "B", since } })).toEqual({ kind: "entering", name: "B", since });
  });
});
