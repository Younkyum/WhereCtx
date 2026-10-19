import { describe, expect, it } from "vitest";
import { NO_DWELL, pendingTransition, step, type DelaysFor, type DwellState, type DwellTransition } from "./dwell.js";

const T0 = Date.parse("2026-06-05T00:00:00.000Z");
const at = (sec: number): Date => new Date(T0 + sec * 1000);

const delays =
  (table: Record<string, [enter: number, exit: number]>): DelaysFor =>
  (name) => {
    const d = table[name];
    return d ? { enterAfterSec: d[0], exitAfterSec: d[1] } : undefined;
  };

/** Step through `(sec, raw)` readings from `state`, collecting every transition. */
function run(
  rules: DelaysFor,
  readings: Array<[sec: number, raw: string | null, insideCurrent?: boolean, drivingBy?: boolean]>,
  state: DwellState = NO_DWELL,
) {
  const transitions: Array<DwellTransition & { sec: number }> = [];
  for (const [sec, raw, insideCurrent = false, drivingBy = false] of readings) {
    const next = step(state, { raw, insideCurrent, drivingBy }, at(sec), rules);
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

  it("starts no leave while a reading in another place is still inside the confirmed one, and hands over once that place confirms", () => {
    const rules = delays({ Home: [0, 600], Garden: [120, 0] });
    const { state, transitions } = run(rules, [
      [0, "Home"],
      [10, "Garden", true],
      [100, "Garden", true],
    ]);
    expect(transitions).toEqual([{ kind: "entered", name: "Home", sec: 0 }]);
    expect(state).toEqual({ current: "Home", exitSince: null, candidate: { name: "Garden", since: at(10).toISOString() } });
    expect(run(rules, [[130, "Garden", true]], state).transitions).toEqual([
      { kind: "left", name: "Home", sec: 130 },
      { kind: "entered", name: "Garden", sec: 130 },
    ]);
  });

  it("leaves a confirmed place that no longer exists at once, and enters what the point is in now", () => {
    const before = run(delays({ A: [0, 600], B: [300, 0] }), [
      [0, "A"],
      [10, "B"],
    ]);
    expect(before.state).toMatchObject({ current: "A", candidate: { name: "B" } });
    expect(run(delays({ C: [0, 0] }), [[20, "C"]], before.state).transitions).toEqual([
      { kind: "left", name: "A", sec: 20 },
      { kind: "entered", name: "C", sec: 20 },
    ]);
  });

  it("confirms no delayed enter while driving past, enters an undelayed place at once, and still confirms a due leave", () => {
    const rules = delays({ A: [60, 0], B: [0, 60], C: [0, 0] });
    const held = run(rules, [
      [0, "A"],
      [120, "A", false, true],
    ]);
    expect(held.transitions).toEqual([]);
    expect(held.state.candidate).toEqual({ name: "A", since: at(0).toISOString() });
    expect(run(rules, [[130, "A"]], held.state).transitions).toEqual([{ kind: "entered", name: "A", sec: 130 }]);

    expect(run(rules, [[0, "C", false, true]]).transitions).toEqual([{ kind: "entered", name: "C", sec: 0 }]);

    const left = run(rules, [
      [0, "B"],
      [10, null],
      [100, null, false, true],
    ]);
    expect(left.transitions).toEqual([
      { kind: "entered", name: "B", sec: 0 },
      { kind: "left", name: "B", sec: 100 },
    ]);
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
