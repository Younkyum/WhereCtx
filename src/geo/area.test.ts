import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { AppContext } from "../app/context.js";
import type { WhereCtxConfig } from "../config.js";
import { asUserId } from "../types.js";
import { Browser, OWNER_ADMIN, TestClock, bootApp, setupOwner, signUpByInvite, type Enrolled } from "../testing/accounts.js";
import type { FakeGeoProvider } from "./fake.js";

const AGENT = "agent-token-strong-0123456789abcdef-geo";
const HOME = { lat: 37.5, lon: 127.0 };
/** Seven decimals, so a call that is not rounded is plain to see. */
const AWAY = { lat: 37.5665432, lon: 126.9784321 };
const AWAY_NEAR = { lat: 37.5671234, lon: 126.9787654 }; // ~70 m from AWAY
const ELSEWHERE = { lat: 37.4979876, lon: 127.0276543 }; // Gangnam, ~9 km

let clock: TestClock;
let ctx: AppContext;
let app: Hono;
let owner: Enrolled;
let fake: FakeGeoProvider;

async function boot(geo: Partial<WhereCtxConfig["geo"]> = {}): Promise<void> {
  clock = new TestClock();
  const booted = await bootApp(clock, {
    bootstrapTokens: { admin: OWNER_ADMIN, agent: AGENT },
    geo: { operatorKeys: { kakao: { provider: "kakao", restKey: "operator-kakao-key-0000" } }, operatorKeyForAll: false, fake: true, ...geo },
  });
  ({ ctx, app } = booted);
  fake = ctx.system.geo.fake!;
  owner = await setupOwner(app, booted.setupCode);
  await owner.browser.json("/v1/places", { body: { name: "home", type: "home", ...HOME, radiusM: 150 } });
}

const settings = (body: Record<string, unknown>, who = owner.browser) => who.json("/v1/privacy", { method: "PUT", body });

async function ingest(at: { lat: number; lon: number }, who = owner.browser): Promise<void> {
  await who.json("/v1/ingest", { body: { source: "manual", ...at } });
  await ctx.system.geo.settled();
}

const reverseCalls = () => fake.calls.filter((c) => c.op === "reverse");

async function areaOf(userId = owner.userId): Promise<string | null> {
  const row = await ctx.handle.client.execute({ sql: "SELECT area FROM presence WHERE user_id = ?", args: [userId] });
  return (row.rows[0]?.area as string | null) ?? null;
}

const agentPresence = async () => (await app.request("/v1/presence", { headers: { authorization: `Bearer ${AGENT}` } })).json() as Promise<any>;

beforeEach(() => boot());
afterEach(async () => {
  await ctx.system.geo.settled();
  ctx.handle.client.close();
});

describe("the background area lookup", () => {
  it("sends nothing while maps are off", async () => {
    await ingest(AWAY);
    await ingest(ELSEWHERE);
    expect(fake.calls).toEqual([]);
    expect(await areaOf()).toBeNull();
  });

  it("sends the reading rounded to three decimals, and keeps region names only", async () => {
    await settings({ geoEnabled: true });
    await ingest(AWAY);
    expect(reverseCalls()).toEqual([{ op: "reverse", point: { lat: 37.567, lon: 126.978 } }]);
    for (const call of fake.calls) {
      const point = (call as { point: { lat: number; lon: number } }).point;
      for (const v of [point.lat, point.lon]) expect(String(v).split(".")[1]!.length).toBeLessThanOrEqual(3);
    }
    expect(await areaOf()).toMatch(/^테스트구 테스트\d+동$/);
  });

  it("sends nothing at or near home while skipProviderNearHome is on, and drops the area", async () => {
    await settings({ geoEnabled: true });
    await ingest(AWAY);
    expect(await areaOf()).not.toBeNull();
    clock.advance(10 * 60_000);
    await ingest(HOME);
    await ingest({ lat: HOME.lat + 0.002, lon: HOME.lon }); // near_home
    expect(reverseCalls()).toHaveLength(1);
    expect(await areaOf()).toBeNull();

    await settings({ skipProviderNearHome: false });
    await ctx.system.geo.settled();
    expect(reverseCalls()).toHaveLength(2);
  });

  it("looks up at most every two minutes, and only after moving 200 m", async () => {
    await settings({ geoEnabled: true });
    await ingest(AWAY);
    await ingest(AWAY_NEAR);
    expect(reverseCalls()).toHaveLength(1);
    await ingest(ELSEWHERE);
    expect(reverseCalls()).toHaveLength(1);
    clock.advance(2 * 60_000);
    await ingest(ELSEWHERE);
    expect(reverseCalls()).toHaveLength(2);
  });

  it("answers a cell it has seen from the cache, per person", async () => {
    await boot({ operatorKeyForAll: true });
    await settings({ geoEnabled: true });
    await ingest(AWAY);
    clock.advance(3 * 60_000);
    await ingest(ELSEWHERE);
    clock.advance(3 * 60_000);
    await ingest(AWAY);
    expect(reverseCalls()).toHaveLength(2);

    const { url } = await owner.browser.json(`/v1/workspaces/${(await owner.browser.json("/v1/workspaces")).workspaces[0].id}/invites`, {
      body: { role: "member" },
    });
    const mina = await signUpByInvite(app, url, "Mina");
    const minaId = ((await mina.res.json()) as any).userId;
    await settings({ geoEnabled: true }, mina.browser);
    await ingest(AWAY, mina.browser);
    expect(reverseCalls()).toHaveLength(3);
    expect(await areaOf(minaId)).toBe(await areaOf());
  });

  it("uses operator keys only for USER_ID unless GEO_OPERATOR_KEY_FOR_ALL", async () => {
    const { url } = await owner.browser.json(`/v1/workspaces/${(await owner.browser.json("/v1/workspaces")).workspaces[0].id}/invites`, {
      body: { role: "member" },
    });
    const mina = await signUpByInvite(app, url, "Mina");
    const minaId = ((await mina.res.json()) as any).userId;
    await settings({ geoEnabled: true }, mina.browser);
    await ingest(AWAY, mina.browser);
    expect(fake.calls).toEqual([]);
    expect(await ctx.system.geo.status(asUserId(minaId))).toMatchObject({ active: null, operator: [] });
    expect(await ctx.system.geo.status(asUserId(owner.userId))).toMatchObject({
      active: { provider: "kakao", source: "operator" },
      operator: ["kakao"],
    });

    await ctx.system.geo.saveCredential(asUserId(minaId), { provider: "naver", clientId: "mina-id-0000", clientSecret: "mina-secret" });
    clock.advance(3 * 60_000);
    await ingest(ELSEWHERE, mina.browser);
    expect(reverseCalls()).toHaveLength(1);
    expect(await ctx.system.geo.status(asUserId(minaId))).toMatchObject({ active: { provider: "naver", source: "own" } });
  });

  it("logs each lookup as the system, without coordinates", async () => {
    await settings({ geoEnabled: true });
    await ingest(AWAY);
    const { entries } = await owner.browser.json("/v1/activity/access");
    const lookup = entries.find((e: any) => e.action === "geo.reverse");
    expect(lookup).toMatchObject({ credential: { kind: "system", id: "system" }, surface: "system", outcome: "allowed", precise: false });
    const rows = await ctx.handle.client.execute("SELECT * FROM access_log");
    expect(JSON.stringify(rows.rows)).not.toMatch(/37\.5|126\.9/);
  });

  it("drops the area when maps are turned off, and when a lookup fails, without retrying at once", async () => {
    await settings({ geoEnabled: true });
    await ingest(AWAY);
    await settings({ geoEnabled: false });
    await ctx.system.geo.settled();
    expect(await areaOf()).toBeNull();

    await settings({ geoEnabled: true });
    await ctx.system.geo.settled();
    expect(await areaOf()).not.toBeNull();
    fake.failWith = "quota";
    clock.advance(3 * 60_000);
    await ingest(ELSEWHERE);
    expect(await areaOf()).toBeNull();
    const calls = reverseCalls().length;
    await ingest({ lat: ELSEWHERE.lat + 0.01, lon: ELSEWHERE.lon });
    expect(reverseCalls()).toHaveLength(calls);
  });

  it("drops a lookup for a reading the person has already moved on from", async () => {
    await settings({ geoEnabled: true });
    await ingest(ELSEWHERE);
    await ctx.system.service.setArea(asUserId(owner.userId), {
      region: { region1: "서울특별시", region2: "중구", region3: "명동", label: "중구 명동" },
      forPoint: AWAY,
    });
    expect(await areaOf()).not.toBe("중구 명동");
  });
});

describe("who sees the area", () => {
  beforeEach(async () => {
    await settings({ geoEnabled: true });
    await ingest(AWAY);
  });

  it("agents only with areaToAgents", async () => {
    expect(await agentPresence()).not.toHaveProperty("area");
    await settings({ areaToAgents: true });
    expect((await agentPresence()).area).toMatch(/^테스트구/);
    await settings({ geoEnabled: false });
    await ctx.system.geo.settled();
    expect(await agentPresence()).not.toHaveProperty("area");
  });

  it("the owner always, while maps are on", async () => {
    expect((await owner.browser.json("/v1/presence")).area).toMatch(/^테스트구/);
    const second = new Browser(app);
    expect((await second.send("/v1/presence")).status).toBe(401);
  });
});
