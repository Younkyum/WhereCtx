import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { AppContext } from "../app/context.js";
import type { WhereCtxConfig } from "../config.js";
import type { NormalizedReading } from "../normalizer/types.js";
import { asUserId, type PrivacySettings, type TokenScope } from "../types.js";
import { TestClock, bootApp } from "../testing/accounts.js";
import { keepouts } from "./clearance.js";
import { agentRoads } from "./eta.js";
import type { AgentCaller, EtaOutcome, EtaRequest } from "./service.js";

const OWNER = asUserId("owner");
const HOUR = 3600_000;
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/** Where the documented Kakao sample starts and ends (판교). */
const ORIGIN = { lat: 37.40246478787756, lon: 127.10763058573032 };
const DESTINATION = { lat: 37.394425724914576, lon: 127.1098265381582 };

let clock: TestClock;
let ctx: AppContext;

/** The paths of every request the sample fetch answered. */
const fetched: string[] = [];

/** The providers' documented sample answers, by endpoint. */
const sampleFetch = (async (input: URL | string) => {
  const url = new URL(String(input));
  fetched.push(url.pathname);
  const routing: Record<string, string> = {
    "/v2/routing/publictraffic": "kakao-transit-transfers.json",
    "/v2/routing/walk": "kakao-walk.json",
    "/v2/routing/bicycle": "kakao-bicycle.json",
  };
  const body = routing[url.pathname]
    ? fixture(routing[url.pathname]!)
    : url.pathname.endsWith("/directions")
    ? fixture("kakao-directions.json")
    : url.pathname === "/map-direction/v1/driving"
      ? fixture("naver-directions5.json")
      : url.pathname.includes("reversegeocode")
        ? fixture("naver-reversegeocode.json")
        : fixture("kakao-coord2regioncode.json");
  return new Response(body);
}) as typeof fetch;

async function boot(geo: Partial<WhereCtxConfig["geo"]>, fetch?: typeof fetch): Promise<void> {
  clock = new TestClock();
  fetched.length = 0;
  ({ ctx } = await bootApp(
    clock,
    {
      geo: {
        operatorMapKeys: {},
        operatorKeys: {
          kakao: { provider: "kakao", restKey: "operator-kakao-key-0000" },
          naver: { provider: "naver", clientId: "operator-naver-id", clientSecret: "operator-naver-secret" },
        },
        operatorKeyForAll: false,
        operatorDailyCap: 200,
        fake: false,
        ...geo,
      },
    },
    {},
    fetch ? { geoFetch: fetch } : {},
  ));
  booted = true;
}

let booted = false;
afterEach(async () => {
  if (!booted) return;
  booted = false;
  await ctx.system.geo.settled();
  ctx.handle.client.close();
});

const agent = (scopes: TokenScope[] = ["read_presence"]): AgentCaller => ({
  kind: "agent",
  credential: { kind: "token", id: "tok-1", name: "Claude" },
  surface: "mcp",
  scopes,
});

const set = (patch: Partial<PrivacySettings>) => ctx.system.settings.update(OWNER, patch);
const place = (name: string, type: "home" | "work" | "custom", at: { lat: number; lon: number }) =>
  ctx.forUser(OWNER).places.upsert({ name, type, ...at, radiusM: 150 });
const read = (at: { lat: number; lon: number }, motion?: NormalizedReading["motion"]) =>
  ctx.forUser(OWNER).presence.processReading({
    precise: { ...at, accuracyM: 10 },
    source: "owntracks",
    ...(motion ? { motion } : {}),
    updatedAt: clock.fn().toISOString(),
  });
/** A route by car unless the request names a mode. */
const eta = (
  request: Omit<EtaRequest, "mode"> & Partial<Pick<EtaRequest, "mode">>,
  caller: AgentCaller | { kind: "owner" } = agent(),
): Promise<EtaOutcome> => {
  const full: EtaRequest = { mode: "car", ...request };
  return caller.kind === "agent" ? ctx.system.geo.eta(OWNER, full, caller) : ctx.system.geo.ownerEta(OWNER, full);
};

describe("the roads an agent is told", () => {
  const at = (km: number) => ({ lat: ORIGIN.lat + km / 111, lon: ORIGIN.lon });
  const road = (name: string, km: number, distanceM = 1000) => ({ name, distanceM, path: [at(km)] });

  it("keeps main roads clear of both ends, drops side streets and roads of unknown whereabouts", () => {
    const roads = [
      road("판교역로", 0.5, 5000),
      road("경부고속도로", 5, 4000),
      road("테헤란로12길", 5, 3000),
      { name: "분당내곡로", distanceM: 9000, path: [] },
      road("서울외곽순환고속도로", 8, 2000),
      road("목적지앞로", 9.8, 6000),
    ];
    expect(agentRoads(roads, keepouts([ORIGIN, at(10)], []))).toEqual(["경부고속도로", "서울외곽순환고속도로"]);
    expect(agentRoads(roads, keepouts([ORIGIN], []))).toEqual(["목적지앞로", "경부고속도로", "서울외곽순환고속도로"]);
  });
});

describe("an agent's route, from the providers' documented samples", () => {
  async function setUp(provider: "kakao" | "naver"): Promise<void> {
    await boot({}, sampleFetch);
    await place("home", "home", { lat: 37.5, lon: 127.0 });
    await place("office", "work", DESTINATION);
    await set({ geoEnabled: true, etaToAgents: true, geoProvider: provider });
    await read(ORIGIN);
  }

  it("Kakao: no street the route starts on, no side street, coarse numbers, no fares", async () => {
    await setUp("kakao");
    const outcome = await eta({ to: "office", directions: true });
    const text = JSON.stringify(outcome);
    expect(text).not.toContain("판교역로241번길");
    expect(text).not.toContain("문형산안길1번길");
    expect(text).not.toContain("우회전");
    expect(outcome).toMatchObject({
      kind: "ok",
      precise: false,
      answer: { precision: "approximate", durationMin: 60, distanceKm: 19, summary: ["문형산길"], stepsWithheld: expect.any(String) },
    });
    const answer = (outcome as Extract<EtaOutcome, { kind: "ok" }>).answer;
    for (const key of ["steps", "taxiFare", "tollFare"]) expect(answer).not.toHaveProperty(key);
  });

  it("Naver: the first turn's intersection is never named, and roads without geometry are left out", async () => {
    await setUp("naver");
    const outcome = await eta({ to: "office", directions: true });
    const text = JSON.stringify(outcome);
    expect(text).not.toContain("머내공원사거리");
    expect(text).not.toContain("고기");
    expect(outcome).toMatchObject({ kind: "ok", answer: { provider: "naver", summary: [], stepsWithheld: expect.any(String) } });
  });

  it("gives the steps to an agent that may read the precise location and says why", async () => {
    await setUp("naver");
    await set({ allowPreciseLocation: true });
    const precise = agent(["read_presence", "read_precise_location"]);
    expect(await eta({ to: "office", directions: true }, precise)).toMatchObject({ kind: "ok", answer: { stepsWithheld: expect.any(String) } });
    const outcome = await eta({ to: "office", directions: true, reason: "picking them up" }, precise);
    expect(outcome).toMatchObject({ kind: "ok", precise: true, answer: { steps: [expect.stringContaining("머내공원사거리")] } });
  });

  it("the owner gets the route as the provider gave it", async () => {
    await setUp("kakao");
    const outcome = await eta({ to: "office" }, { kind: "owner" });
    expect(outcome).toMatchObject({
      kind: "ok",
      answer: { precision: "exact", durationMin: 58, distanceKm: 19, taxiFare: 22200, summary: expect.arrayContaining(["판교역로241번길"]) },
    });
  });
});

describe("a transit, walking or cycling route, from Kakao's documented samples", () => {
  /** Where kakao-transit-transfers.json starts (판교) and ends (서울시청). */
  const START = { lat: 37.3929, lon: 127.1105 };
  const CITY_HALL = { lat: 37.5663, lon: 126.9779 };
  const STOPS = ["판교", "청계산입구", "양재시민의숲", "양재", "강남", "신사역", "한남대교남단", "남산예장공원", "명동입구", "서울시청"];
  const NEAR_END_WORDS = ["판교역로146번길", "세종대로", "출구", ...STOPS];
  const LINES_NEAR_ENDS = ["신분당선", "지선 7011"];

  async function setUp(provider: "kakao" | "naver" = "kakao"): Promise<void> {
    await boot({}, sampleFetch);
    await place("home", "home", { lat: 37.45, lon: 127.3 });
    await place("city hall", "work", CITY_HALL);
    await set({ geoEnabled: true, etaToAgents: true, geoProvider: provider });
    await read(START);
  }
  const ok = (outcome: EtaOutcome) => {
    if (outcome.kind !== "ok") throw new Error(`expected an answer, got ${outcome.kind}`);
    return outcome;
  };

  it("an agent hears no line when the first and last rides run near the ends, no transfers, coarse minutes; never a stop, a fare or a street", async () => {
    await setUp();
    const outcome = ok(await eta({ to: "city hall", mode: "transit", directions: true }));
    const text = JSON.stringify(outcome);
    for (const word of [...NEAR_END_WORDS, ...LINES_NEAR_ENDS, "간선 472", "간선 421"]) expect(text).not.toContain(word);
    expect(outcome).toMatchObject({
      precise: false,
      answer: {
        mode: "transit",
        precision: "approximate",
        summary: [],
        durationMin: 60,
        walkMin: 10,
        distanceKm: 27,
        stepsWithheld: expect.any(String),
      },
    });
    for (const key of ["fare", "legs", "path", "steps", "traffic", "transfers"]) expect(outcome.answer).not.toHaveProperty(key);
  });

  it("an agent that may read the precise location hears each ride's first line, still no stop", async () => {
    await setUp();
    await set({ allowPreciseLocation: true });
    const outcome = ok(await eta({ to: "city hall", mode: "transit", reason: "meeting there" }, agent(["read_presence", "read_precise_location"])));
    expect(outcome).toMatchObject({ precise: true, answer: { summary: ["신분당선", "간선 472", "지선 7011"], transfers: 2 } });
    const text = JSON.stringify(outcome);
    for (const stop of STOPS) expect(text).not.toContain(stop);
  });

  it("the owner gets every leg with its stops, the fare and the route as drawn", async () => {
    await setUp();
    const { answer } = ok(await eta({ to: "city hall", mode: "transit" }, { kind: "owner" }));
    expect(answer).toMatchObject({ mode: "transit", precision: "exact", durationMin: 62, fare: 2650, transfers: 2, walkMin: 8 });
    if (answer.precision !== "exact") throw new Error("not the owner's answer");
    expect(answer.legs!.map((l) => [l.kind, l.lines, l.stops.at(0), l.stops.at(-1)])).toEqual([
      ["walk", [], undefined, undefined],
      ["subway", ["신분당선"], "판교", "강남"],
      ["bus", ["간선 472", "간선 421"], "강남역", "남산예장공원"],
      ["bus", ["지선 7011"], "남산예장공원", "서울시청"],
      ["walk", [], undefined, undefined],
    ]);
    expect(answer.legs![1]!.path[0]).toEqual({ lat: 37.3948, lon: 127.1111 });
    expect(answer.path.at(-1)).toEqual({ lat: 37.5663, lon: 126.9779 });
  });

  it.each(["walk", "bike"] as const)("%s: an agent hears coarse numbers and no street; the steps need precise access", async (mode) => {
    await setUp();
    const outcome = ok(await eta({ to: "city hall", mode, directions: true }));
    const text = JSON.stringify(outcome);
    for (const word of ["판교역로", "성남대로", "탄천자전거길", "출구", "이동"]) expect(text).not.toContain(word);
    expect(outcome.answer).toMatchObject({ mode, summary: [], stepsWithheld: expect.any(String) });

    await set({ allowPreciseLocation: true });
    const precise = ok(await eta({ to: "city hall", mode, directions: true, reason: "walking over" }, agent(["read_presence", "read_precise_location"])));
    expect(precise).toMatchObject({ precise: true, answer: { steps: expect.arrayContaining([expect.stringContaining("이동")]) } });
  });

  it.each(["transit", "walk", "bike"] as const)("Naver answers %s as unsupported_mode and sends nothing", async (mode) => {
    await setUp("naver");
    expect(await eta({ to: "city hall", mode })).toEqual({ kind: "unsupported_mode", mode, provider: "naver", supported: ["car"], switchTo: ["kakao"] });
    expect(fetched.filter((p) => !p.includes("reversegeocode"))).toEqual([]);
  });

  it("records each call under its mode in the access log", async () => {
    await setUp();
    for (const mode of ["car", "transit", "walk", "bike"] as const) ok(await eta({ to: "city hall", mode }));
    const rows = (await ctx.system.accessLog.list(OWNER)).entries.map((e) => e.action).filter((a) => a.startsWith("geo.route"));
    expect(rows.sort()).toEqual(["geo.route", "geo.route.bike", "geo.route.transit", "geo.route.walk"]);
  });

  it("keeps the gates: near home is refused, an address needs precise access", async () => {
    await setUp();
    expect(await eta({ to: "서울특별시청", mode: "transit" })).toMatchObject({ kind: "denied", reason: expect.stringContaining("registered place") });
    await read({ lat: 37.45, lon: 127.3 });
    expect(await eta({ to: "city hall", mode: "transit" })).toMatchObject({ kind: "denied", reason: expect.stringContaining("near home") });
    expect(fetched.filter((p) => p.startsWith("/v2/routing"))).toEqual([]);
  });
});

describe("polling an agent's ETA with a moving clock and a moving phone", () => {
  const STEP_MS = 5 * 60_000;
  const TTL_MS = 5 * 60_000;
  const office = { lat: 37.55, lon: 127.05 };

  it.each([
    ["car", 5],
    ["transit", 5],
    ["walk", 15],
    ["bike", 15],
  ] as const)("%s: one answer per 5 minutes, and no pair of fields finer than a %i-minute step", async (mode, stepMin) => {
    await boot({ fake: true });
    await place("office", "work", office);
    await set({ geoEnabled: true, etaToAgents: true });
    const routeCalls = () => ctx.system.geo.fake!.calls.filter((c) => c.op === "route").length;
    let window: { start: number; answer: unknown } | null = null;
    let windows = 0;
    for (let i = 0; i < 24; i++) {
      await read({ lat: 37.4 + i * 0.002, lon: 127.0 + i * 0.0013 });
      const outcome = await eta({ to: "office", mode });
      if (outcome.kind !== "ok") throw new Error(`expected an answer, got ${outcome.kind}`);
      const { answer } = outcome;
      if (!window || clock.now - window.start >= TTL_MS) {
        window = { start: clock.now, answer };
        windows += 1;
      }
      expect(answer, "the same answer within the window").toEqual(window.answer);
      expect(Date.parse(answer.departAt) % STEP_MS, "departAt on a 5-minute step").toBe(0);
      expect(Date.parse(answer.arriveAt) - Date.parse(answer.departAt), "arriveAt is departAt plus the rounded minutes").toBe(answer.durationMin * 60_000);
      expect(answer.durationMin % (answer.durationMin >= 15 ? stepMin : 5), "minutes in steps").toBe(0);
      expect(Number.isInteger(answer.distanceKm) && answer.distanceKm >= 1, "whole kilometres").toBe(true);
      if (answer.walkMin !== undefined) expect(answer.walkMin % 5).toBe(0);
      clock.advance(37_000);
    }
    expect(windows).toBeGreaterThan(2);
    expect(routeCalls(), "a kept answer asks the provider nothing").toBe(windows);
  });

  it("each credential, destination and mode is kept apart", async () => {
    await boot({ fake: true });
    await place("office", "work", office);
    await place("gym", "custom", { lat: 37.6, lon: 126.9 });
    await set({ geoEnabled: true, etaToAgents: true });
    await read({ lat: 37.4, lon: 127.0 });
    const routeCalls = () => ctx.system.geo.fake!.calls.filter((c) => c.op === "route").length;
    const other: AgentCaller = { ...agent(), credential: { kind: "token", id: "tok-2", name: "Other" } };
    for (const [request, caller] of [
      [{ to: "office" }, agent()],
      [{ to: "office" }, agent()],
      [{ to: "office" }, other],
      [{ to: "gym" }, agent()],
      [{ to: "office", mode: "walk" as const }, agent()],
    ] as const) await eta(request, caller);
    expect(routeCalls()).toBe(4);
  });

  it("the owner is never served a kept answer", async () => {
    await boot({ fake: true });
    await place("office", "work", office);
    await set({ geoEnabled: true, etaToAgents: true });
    await read({ lat: 37.4, lon: 127.0 });
    await eta({ to: "office" }, { kind: "owner" });
    await eta({ to: "office" }, { kind: "owner" });
    expect(ctx.system.geo.fake!.calls.filter((c) => c.op === "route")).toHaveLength(2);
  });
});

describe("how fresh a reading must be to start a route from (a connected phone)", () => {
  const OFFICE = { lat: 37.4, lon: 127.1 };
  const CAFE = { lat: 37.56, lon: 126.97 };

  async function setUp(): Promise<void> {
    await boot({ fake: true });
    await place("home", "home", { lat: 37.5, lon: 127.0 });
    await place("office", "work", OFFICE);
    await place("gym", "custom", { lat: 37.52, lon: 127.05 });
    await set({ geoEnabled: true, etaToAgents: true });
  }

  it("three quiet hours inside a registered place: allowed, and the answer says how old", async () => {
    await setUp();
    await read(OFFICE);
    clock.advance(3 * HOUR);
    expect(await eta({ to: "gym" })).toMatchObject({ kind: "ok", answer: { freshness: "stationary", originAgeMin: 180 } });
  });

  it("three quiet hours away from any place: refused, stationary", async () => {
    await setUp();
    await read(CAFE);
    clock.advance(3 * HOUR);
    expect(await eta({ to: "gym" })).toEqual({ kind: "too_old", freshness: "stationary", originAgeMin: 180 });
  });

  it("three quiet hours after driving: refused, unknown", async () => {
    await setUp();
    await read(CAFE, "driving");
    clock.advance(3 * HOUR);
    expect(await eta({ to: "gym" })).toEqual({ kind: "too_old", freshness: "unknown", originAgeMin: 180 });
  });

  it("23 hours: still inside a place is allowed, away is refused; past the offline window nothing is", async () => {
    await setUp();
    await read(OFFICE);
    clock.advance(23 * HOUR);
    expect(await eta({ to: "gym" })).toMatchObject({ kind: "ok", answer: { freshness: "stationary", originAgeMin: 1380 } });
    clock.advance(2 * HOUR);
    expect(await eta({ to: "gym" })).toMatchObject({ kind: "too_old", freshness: "offline" });

    await read(CAFE);
    clock.advance(23 * HOUR);
    expect(await eta({ to: "gym" })).toMatchObject({ kind: "too_old", freshness: "stationary" });
  });

  it("the owner is held to the same gate", async () => {
    await setUp();
    await read(CAFE, "driving");
    clock.advance(3 * HOUR);
    expect(await eta({ to: "gym" }, { kind: "owner" })).toMatchObject({ kind: "too_old" });
    expect(ctx.system.geo.fake!.calls.filter((c) => c.op === "route")).toEqual([]);
  });
});
