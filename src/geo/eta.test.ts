import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { AppContext } from "../app/context.js";
import type { WhereCtxConfig } from "../config.js";
import type { NormalizedReading } from "../normalizer/types.js";
import { asUserId, type PrivacySettings, type TokenScope } from "../types.js";
import { TestClock, bootApp } from "../testing/accounts.js";
import type { GeoCaller } from "./keys.js";
import { agentRoads } from "./eta.js";
import type { EtaOutcome, EtaRequest } from "./service.js";

const OWNER = asUserId("owner");
const HOUR = 3600_000;
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/** Where the documented Kakao sample starts and ends (판교). */
const ORIGIN = { lat: 37.40246478787756, lon: 127.10763058573032 };
const DESTINATION = { lat: 37.394425724914576, lon: 127.1098265381582 };

let clock: TestClock;
let ctx: AppContext;

/** The providers' documented sample answers, by endpoint. */
const sampleFetch = (async (input: URL | string) => {
  const url = new URL(String(input));
  const body = url.pathname.endsWith("/directions")
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

const agent = (scopes: TokenScope[] = ["read_presence"]): GeoCaller => ({
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
const eta = (request: EtaRequest, caller: GeoCaller = agent()): Promise<EtaOutcome> => ctx.system.geo.eta(OWNER, request, caller);

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
    expect(agentRoads(roads, [ORIGIN, at(10)])).toEqual(["경부고속도로", "서울외곽순환고속도로"]);
    expect(agentRoads(roads, [ORIGIN])).toEqual(["목적지앞로", "경부고속도로", "서울외곽순환고속도로"]);
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
