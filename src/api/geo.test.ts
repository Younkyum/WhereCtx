import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { AppContext } from "../app/context.js";
import type { WhereCtxConfig } from "../config.js";
import { OWNER_ADMIN, TestClock, bootApp, reauth, setupOwner, signUpByInvite, type Enrolled } from "../testing/accounts.js";
import type { FakeGeoProvider } from "../geo/fake.js";
import { GEO_USER_CALLS_PER_MINUTE, KEY_TEST_POINT } from "../geo/keys.js";
import { roundCoord } from "../geo/types.js";

const AGENT = "agent-token-strong-0123456789abcdef-eta";
const HOME = { lat: 37.5, lon: 127.0 };
const AWAY = { lat: 37.5665432, lon: 126.9784321 };
const KAKAO_KEY = "kakao-rest-key-0123456789abcdef";

let clock: TestClock;
let ctx: AppContext;
let app: Hono;
let owner: Enrolled;
let fake: FakeGeoProvider;

async function boot(geo: Partial<WhereCtxConfig["geo"]> = {}, geoFetch?: typeof fetch): Promise<void> {
  clock = new TestClock();
  const booted = await bootApp(
    clock,
    {
      bootstrapTokens: { admin: OWNER_ADMIN, agent: AGENT },
      geo: { operatorMapKeys: {}, operatorKeys: { kakao: { provider: "kakao", restKey: "operator-kakao-key-0000" } }, operatorKeyForAll: false, fake: true, ...geo },
    },
    {},
    geoFetch ? { geoFetch } : {},
  );
  ({ ctx, app } = booted);
  fake = ctx.system.geo.fake!;
  owner = await setupOwner(app, booted.setupCode);
  await owner.browser.json("/v1/places", { body: { name: "home", type: "home", ...HOME, radiusM: 150 } });
  await owner.browser.json("/v1/places", { body: { name: "office", type: "work", lat: 37.4, lon: 127.1, radiusM: 150 } });
}

const as = (token: string, path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });

const settings = (body: Record<string, unknown>) => owner.browser.json("/v1/privacy", { method: "PUT", body });

async function ingest(at: { lat: number; lon: number }): Promise<void> {
  await owner.browser.json("/v1/ingest", { body: { source: "manual", ...at } });
  await ctx.system.geo.settled();
}

const routeCalls = () => fake.calls.flatMap((c) => (c.op === "route" ? [c.request] : []));

async function accessRows(): Promise<any[]> {
  return (await owner.browser.json("/v1/activity/access?limit=200")).entries;
}

afterEach(async () => {
  await ctx.system.geo.settled();
  ctx.handle.client.close();
});

describe("maps keys", () => {
  beforeEach(() => boot());

  it("are saved with a fresh passkey, and never come back", async () => {
    clock.advance(11 * 60_000);
    let res = await owner.browser.send("/v1/geo/credentials/kakao", { method: "PUT", body: { restKey: KAKAO_KEY } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).code).toBe("reauth_required");
    await reauth(owner.browser, owner.credentialId);
    res = await owner.browser.send("/v1/geo/credentials/kakao", { method: "PUT", body: { restKey: KAKAO_KEY } });
    expect(res.status).toBe(200);
    const saved = JSON.stringify(await res.json());
    const status = JSON.stringify(await owner.browser.json("/v1/geo"));
    for (const text of [saved, status]) {
      expect(text).not.toContain(KAKAO_KEY);
      expect(text).toContain('"restKey":"cdef"');
    }
    expect(JSON.parse(status).active).toEqual({ provider: "kakao", source: "own" });

    clock.advance(11 * 60_000);
    expect((await owner.browser.send("/v1/geo/credentials/kakao", { method: "DELETE" })).status).toBe(403);
    await reauth(owner.browser, owner.credentialId);
    expect((await owner.browser.send("/v1/geo/credentials/kakao", { method: "DELETE" })).status).toBe(200);
    expect((await owner.browser.json("/v1/geo")).credentials).toEqual([]);
  });

  it("a corrupted key row is reported unusable, skipped for calls, and can be replaced or removed", async () => {
    await owner.browser.json("/v1/geo/credentials/kakao", { method: "PUT", body: { restKey: KAKAO_KEY } });
    await ctx.handle.client.execute("UPDATE geo_credentials SET secret = 'enc:v1:Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eA=='");
    const status = await owner.browser.send("/v1/geo");
    expect(status.status).toBe(200);
    const body = (await status.json()) as any;
    expect(body.credentials[0]).toMatchObject({ provider: "kakao", status: "unusable" });
    expect(body.active).toEqual({ provider: "kakao", source: "operator" });
    const { test } = await owner.browser.json("/v1/geo/credentials/kakao/test", { method: "POST" });
    expect(test).toMatchObject({ ok: false, error: "missing", message: expect.stringMatching(/save it again/) });
    await owner.browser.json("/v1/geo/credentials/kakao", { method: "PUT", body: { restKey: KAKAO_KEY } });
    expect((await owner.browser.json("/v1/geo")).credentials[0].status).toBe("ok");
    await ctx.handle.client.execute("UPDATE geo_credentials SET secret = 'garbage'");
    expect((await owner.browser.send("/v1/geo/credentials/kakao", { method: "DELETE" })).status).toBe(200);
  });

  it("refuses malformed keys and unknown providers", async () => {
    expect((await owner.browser.send("/v1/geo/credentials/kakao", { method: "PUT", body: { restKey: "has space key" } })).status).toBe(400);
    expect((await owner.browser.send("/v1/geo/credentials/kakao", { method: "PUT", body: { restKey: KAKAO_KEY, extra: "x" } })).status).toBe(400);
    expect((await owner.browser.send("/v1/geo/credentials/naver", { method: "PUT", body: { clientId: "only-the-id" } })).status).toBe(400);
    expect((await owner.browser.send("/v1/geo/credentials/google", { method: "PUT", body: { restKey: KAKAO_KEY } })).status).toBe(404);
  });

  it("are a session's business: every token is refused, and recorded", async () => {
    for (const [method, path] of [
      ["GET", "/v1/geo"],
      ["PUT", "/v1/geo/credentials/kakao"],
      ["DELETE", "/v1/geo/credentials/kakao"],
      ["POST", "/v1/geo/credentials/kakao/test"],
    ] as const) {
      const res = await as(OWNER_ADMIN, path, { method, body: method === "PUT" ? JSON.stringify({ restKey: KAKAO_KEY }) : undefined });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect((await accessRows()).map((e) => e.action).sort()).toEqual([
      "geo.credentials.delete",
      "geo.credentials.test",
      "geo.credentials.write",
      "geo.settings",
    ]);
  });
});

describe("the switches that send more out", () => {
  beforeEach(() => boot());

  it.each([
    [{ geoEnabled: true }],
    [{ etaToAgents: true }],
    [{ areaToAgents: true }],
    [{ skipProviderNearHome: false }],
  ])("%o needs a fresh passkey, and never a token; turning it back is free", async (patch) => {
    expect((await as(OWNER_ADMIN, "/v1/privacy", { method: "PUT", body: JSON.stringify(patch) })).status).toBe(403);
    clock.advance(11 * 60_000);
    const stale = await owner.browser.send("/v1/privacy", { method: "PUT", body: patch });
    expect(stale.status).toBe(403);
    expect(((await stale.json()) as any).code).toBe("reauth_required");
    await reauth(owner.browser, owner.credentialId);
    expect((await owner.browser.send("/v1/privacy", { method: "PUT", body: patch })).status).toBe(200);

    clock.advance(11 * 60_000);
    const back = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, !v]));
    expect((await owner.browser.send("/v1/privacy", { method: "PUT", body: back })).status).toBe(200);
    expect((await as(OWNER_ADMIN, "/v1/privacy", { method: "PUT", body: JSON.stringify(back) })).status).toBe(200);
  });

  it("the Home area switch too, once it is off", async () => {
    await settings({ areaOnHome: false });
    expect((await as(OWNER_ADMIN, "/v1/privacy", { method: "PUT", body: JSON.stringify({ areaOnHome: true }) })).status).toBe(403);
    expect((await as(OWNER_ADMIN, "/v1/privacy", { method: "PUT", body: JSON.stringify({ areaOnHome: false, retentionHours: 12 }) })).status).toBe(200);
    expect((await owner.browser.json("/v1/privacy")).settings).toMatchObject({ areaOnHome: false, geoEnabled: false });
  });
});

describe("testing a key", () => {
  it("looks up Seoul City Hall with my key, not where I am, and notes how it went", async () => {
    const sent: URL[] = [];
    const region = JSON.parse(readFileSync(new URL("../geo/fixtures/kakao-coord2regioncode.json", import.meta.url), "utf8"));
    const geoFetch = (async (input: URL | string) => {
      sent.push(new URL(String(input)));
      return new Response(JSON.stringify(region));
    }) as typeof fetch;
    await boot({ fake: false }, geoFetch);
    await settings({ geoEnabled: true, skipProviderNearHome: true });
    await ingest(HOME);
    await owner.browser.json("/v1/geo/credentials/kakao", { method: "PUT", body: { restKey: KAKAO_KEY } });
    const { test } = await owner.browser.json("/v1/geo/credentials/kakao/test", { method: "POST" });
    expect(test).toEqual({ ok: true, label: "성남시 분당구 삼평동" });
    expect(sent.map((u) => [u.searchParams.get("y"), u.searchParams.get("x")])).toEqual([
      [String(roundCoord(KEY_TEST_POINT.lat)), String(roundCoord(KEY_TEST_POINT.lon))],
    ]);
    expect((await owner.browser.json("/v1/geo")).credentials[0].lastUsedAt).not.toBeNull();
  });
});

describe("search", () => {
  beforeEach(() => boot());

  it("needs maps on, for the owner and every token", async () => {
    expect((await owner.browser.send("/v1/geo/search?q=강남역")).status).toBe(403);
    expect((await as(OWNER_ADMIN, "/v1/geo/search?q=강남역")).status).toBe(403);
    expect(fake.calls).toEqual([]);
  });

  it("needs manage_places and a visible presence; the owner and an admin token get coordinates", async () => {
    await settings({ geoEnabled: true });
    expect((await as(AGENT, "/v1/geo/search?q=강남역")).status).toBe(403);
    const mine = await owner.browser.json("/v1/geo/search?q=강남역");
    expect(mine.candidates[0]).toMatchObject({ label: "강남역 2호선", lat: 37.4979, lon: 127.0276 });
    expect((await as(OWNER_ADMIN, "/v1/geo/search?q=강남역")).status).toBe(200);
    expect(fake.calls.filter((c) => c.op === "geocode")).toHaveLength(2);
    await settings({ defaultAgentAccess: "hidden" });
    const hidden = await as(OWNER_ADMIN, "/v1/geo/search?q=강남역");
    expect(hidden.status).toBe(403);
    expect(((await hidden.json()) as any).privacy).toBe("hidden");
    expect(fake.calls.filter((c) => c.op === "geocode")).toHaveLength(2);
  });
});

describe("ETA", () => {
  beforeEach(async () => {
    await boot();
    await ingest(AWAY);
  });

  const eta = (token: string | null, query: string) =>
    token ? as(token, `/v1/geo/eta?${query}`) : owner.browser.send(`/v1/geo/eta?${query}`);

  it("is refused while maps are off, for the owner too, with nothing sent", async () => {
    expect((await eta(null, "to=office")).status).toBe(403);
    expect((await eta(AGENT, "to=office")).status).toBe(403);
    expect(fake.calls).toEqual([]);
  });

  it("is refused to agents without etaToAgents, and in hidden mode", async () => {
    await settings({ geoEnabled: true });
    let res = await eta(AGENT, "to=office");
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toMatch(/etaToAgents/);
    await settings({ etaToAgents: true, defaultAgentAccess: "hidden" });
    res = await eta(AGENT, "to=office");
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).privacy).toBe("hidden");
    expect(routeCalls()).toEqual([]);
    expect((await eta(null, "to=office")).status).toBe(200);
  });

  it("answers agents approximately, with no coordinates, and sends the origin rounded", async () => {
    await settings({ geoEnabled: true, etaToAgents: true });
    const res = await eta(AGENT, "to=office");
    expect(res.status).toBe(200);
    const text = await res.text();
    const { eta: answer } = JSON.parse(text);
    expect(answer).toMatchObject({
      destination: { label: "office", kind: "place" },
      origin: "current_location",
      precision: "approximate",
      traffic: "live",
      provider: "kakao",
      freshness: "live",
      originAgeMin: 0,
    });
    expect(answer.durationMin % 5).toBe(0);
    expect(Number.isInteger(answer.distanceKm)).toBe(true);
    expect(new Date(answer.arriveAt).getUTCMinutes() % 5).toBe(0);
    for (const key of ["deepLinks", "steps", "taxiFare", "tollFare", "trafficAware", "path"]) expect(answer).not.toHaveProperty(key);
    for (const n of [AWAY.lat, AWAY.lon, 37.567, 126.978, 37.4, 127.1]) expect(text).not.toContain(String(n));
    expect(routeCalls()[0]!.origin).toEqual({ lat: 37.567, lon: 126.978 });
  });

  it("answers the owner exactly, with steps, fares and links", async () => {
    await settings({ geoEnabled: true });
    const { eta: answer } = await owner.browser.json("/v1/geo/eta?to=office");
    expect(answer).toMatchObject({ precision: "exact", freshness: "live", originAgeMin: 0 });
    expect(answer.steps.length).toBeGreaterThan(0);
    expect(answer).toHaveProperty("taxiFare");
    expect(answer.path).toHaveLength(3);
    expect(answer.path[0]).toEqual(routeCalls()[0]!.origin);
    expect(answer.summary).toContain("테스트출발로12번길");
  });

  it("sends a registered destination rounded too", async () => {
    await settings({ geoEnabled: true });
    await owner.browser.json("/v1/places", { body: { name: "clinic", type: "custom", lat: 37.4012345, lon: 127.1098765, radiusM: 100 } });
    await owner.browser.json("/v1/geo/eta?to=clinic");
    expect(routeCalls().at(-1)).toMatchObject({ origin: { lat: 37.567, lon: 126.978 }, destination: { lat: 37.401, lon: 127.11 } });
  });

  it("takes an agent only to a registered place, unless it may read the precise location", async () => {
    await settings({ geoEnabled: true, etaToAgents: true });
    const refused = await eta(AGENT, "to=" + encodeURIComponent("강남역"));
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as any).error).toMatch(/registered place/);
    expect(fake.calls.filter((c) => c.op === "geocode")).toEqual([]);

    expect((await eta(AGENT, "to=" + encodeURIComponent("강남역") + "&reason=meeting")).status).toBe(403);
    await settings({ allowPreciseLocation: true });
    expect((await eta(AGENT, "to=" + encodeURIComponent("강남역"))).status).toBe(403);
    const byAddress = (await (await eta(AGENT, "to=" + encodeURIComponent("강남역") + "&reason=meeting")).json()) as any;
    expect(byAddress.eta.destination).toEqual({ label: "강남역 2호선", kind: "address" });
    expect(byAddress.eta.deepLinks.kakaoMap).toContain("37.4979,127.0276");
    const row = (await accessRows()).find((e) => e.action === "geo.eta" && e.outcome === "allowed");
    expect(row).toMatchObject({ precise: true, reason: "meeting" });
  });

  it("gives map links to the owner and to a place manager", async () => {
    await settings({ geoEnabled: true, etaToAgents: true });
    expect((await owner.browser.json("/v1/geo/eta?to=office")).eta.deepLinks.kakaoMap).toBe(
      "https://map.kakao.com/link/to/office,37.4,127.1",
    );
    expect((await (await eta(OWNER_ADMIN, "to=office")).json() as any).eta.deepLinks.naverMap).toBe("nmap://navigation?dlat=37.4&dlng=127.1&dname=office&appname=wherectx");
  });

  it("asks which one when a search finds several", async () => {
    await settings({ geoEnabled: true });
    const res = await owner.browser.send("/v1/geo/eta?to=" + encodeURIComponent("판교역"));
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.candidates.map((c: any) => [c.pick, c.label])).toEqual([
      [1, "판교역 신분당선"],
      [2, "판교역 경강선"],
    ]);
    expect((await owner.browser.send("/v1/geo/eta?to=" + encodeURIComponent("판교역") + "&pick=2")).status).toBe(200);
  });

  it("refuses an agent at or near home, by distance, whatever the status says; the owner is timed from the home place", async () => {
    await settings({ geoEnabled: true, etaToAgents: true });
    // A place of their own 200 m from home: the status says "custom", the distance says near home.
    await owner.browser.json("/v1/places", { body: { name: "corner", type: "custom", lat: HOME.lat + 0.0018, lon: HOME.lon, radiusM: 100 } });
    await ingest({ lat: HOME.lat + 0.0018123, lon: HOME.lon + 0.0000123 });
    expect((await owner.browser.json("/v1/presence")).status).toBe("custom");
    const before = routeCalls().length;
    const res = await eta(AGENT, "to=office");
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toMatch(/at or near home/);
    expect(routeCalls()).toHaveLength(before);

    const { eta: answer } = await owner.browser.json("/v1/geo/eta?to=office");
    expect(answer.origin).toBe("home");
    expect(routeCalls().at(-1)!.origin).toEqual(HOME);
  });

  it("refuses a reading too old to start from, and says how old", async () => {
    await settings({ geoEnabled: true, etaToAgents: true });
    clock.advance(16 * 60_000);
    const res = await eta(AGENT, "to=office");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ freshness: "unknown", originAgeMin: 16, error: expect.stringMatching(/too old/) });
    expect(routeCalls()).toEqual([]);
  });

  it("counts every provider call against the person, the owner's own and a key test included", async () => {
    await owner.browser.json("/v1/geo/credentials/kakao", { method: "PUT", body: { restKey: KAKAO_KEY } });
    await settings({ geoEnabled: true, etaToAgents: true });
    await ctx.system.geo.settled();
    const used = () => fake.calls.length;
    expect(used()).toBe(1); // the background area lookup
    for (let i = 0; i < 14; i++) expect((await eta(null, "to=" + encodeURIComponent("강남역"))).status).toBe(200);
    expect(used()).toBe(29);
    expect((await eta(AGENT, "to=office")).status).toBe(200);
    expect(used()).toBe(GEO_USER_CALLS_PER_MINUTE);
    expect((await eta(AGENT, "to=office")).status).toBe(429);
    expect((await eta(null, "to=office")).status).toBe(429);
    expect((await owner.browser.json("/v1/geo/credentials/kakao/test", { method: "POST" })).test).toMatchObject({ ok: false, error: "rate_limited" });
    expect(used()).toBe(GEO_USER_CALLS_PER_MINUTE);
    clock.advance(61_000);
    await ingest(AWAY);
    expect((await eta(AGENT, "to=office")).status).toBe(200);
  });

  it("caps a day of operator-key calls for anyone but USER_ID", async () => {
    await boot({ operatorKeyForAll: true, operatorDailyCap: 3 });
    await settings({ geoEnabled: true });
    const { url } = await owner.browser.json(`/v1/workspaces/${(await owner.browser.json("/v1/workspaces")).workspaces[0].id}/invites`, {
      body: { role: "member" },
    });
    const mina = await signUpByInvite(app, url, "Mina");
    await mina.browser.json("/v1/places", { body: { name: "office", type: "work", lat: 37.4, lon: 127.1, radiusM: 150 } });
    await mina.browser.json("/v1/ingest", { body: { source: "manual", ...AWAY } });
    await mina.browser.json("/v1/privacy", { method: "PUT", body: { geoEnabled: true } });
    await ctx.system.geo.settled();
    const minaEta = () => mina.browser.send("/v1/geo/eta?to=office");
    expect((await minaEta()).status).toBe(200);
    expect((await minaEta()).status).toBe(200);
    expect((await minaEta()).status).toBe(429);
    clock.advance(86_400_000);
    await mina.browser.json("/v1/ingest", { body: { source: "manual", ...AWAY } });
    await ctx.system.geo.settled();
    expect((await minaEta()).status).toBe(200);

    await ingest(AWAY);
    for (let i = 0; i < 5; i++) expect((await eta(null, "to=office")).status).toBe(200);
  });

  it("logs the route call under the agent, without coordinates", async () => {
    await settings({ geoEnabled: true, etaToAgents: true });
    await eta(AGENT, "to=office");
    await eta(null, "to=office");
    const rows = (await accessRows()).filter((e) => e.action === "geo.route" || e.action === "geo.eta");
    // Both rows share the test clock's millisecond, so their order is not fixed.
    expect(rows.map((e) => [e.action, e.credential.kind, e.surface, e.outcome]).sort()).toEqual([
      ["geo.eta", "token", "rest", "allowed"],
      ["geo.route", "token", "rest", "allowed"],
    ]);
    const raw = JSON.stringify((await ctx.handle.client.execute("SELECT * FROM access_log")).rows);
    expect(raw).not.toMatch(/37\.\d{2}|126\.9|127\.\d/);
  });

  it("maps a provider failure to 502 and notes it", async () => {
    await settings({ geoEnabled: true, etaToAgents: true });
    fake.failWith = "quota";
    const res = await eta(AGENT, "to=office");
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).kind).toBe("quota");
    const row = (await accessRows()).find((e) => e.action === "geo.route");
    expect(row).toMatchObject({ outcome: "error", denial: expect.stringContaining("quota") });
    expect((await accessRows()).find((e) => e.action === "geo.eta")).toMatchObject({ outcome: "error" });
  });
});

describe("the map key and map-config", () => {
  const JS_KEY = "0123456789abcdef0123456789abc123";
  const OPERATOR_JS = "operatorjs0123456789abcdef000000";
  const mapConfig = (who: { browser: Enrolled["browser"] } = owner) => who.browser.json("/v1/geo/map-config");

  async function invite(name: string) {
    const ws = (await owner.browser.json("/v1/workspaces")).workspaces[0].id;
    const { url } = await owner.browser.json(`/v1/workspaces/${ws}/invites`, { body: { role: "member" } });
    return signUpByInvite(app, url, name);
  }

  it("is none without a map key, and none while maps are off", async () => {
    await boot();
    expect(await mapConfig()).toEqual({ provider: null });
    await owner.browser.json("/v1/geo/credentials/kakao/map", { method: "PUT", body: { key: JS_KEY } });
    expect(await mapConfig()).toEqual({ provider: null });
    await settings({ geoEnabled: true });
    expect(await mapConfig()).toEqual({
      provider: "kakao",
      sdkUrl: `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${JS_KEY}&autoload=false`,
    });
    const res = await owner.browser.send("/v1/geo/map-config");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("is the owner's alone: another person gets none, and a token is refused and recorded", async () => {
    await boot();
    await settings({ geoEnabled: true });
    await owner.browser.json("/v1/geo/credentials/kakao/map", { method: "PUT", body: { key: JS_KEY } });
    const mina = await invite("Mina");
    await mina.browser.json("/v1/privacy", { method: "PUT", body: { geoEnabled: true } });
    expect(await mapConfig(mina)).toEqual({ provider: null });
    expect(JSON.stringify(await mina.browser.json("/v1/geo"))).not.toContain("c123");
    for (const token of [OWNER_ADMIN, AGENT]) {
      const res = await as(token, "/v1/geo/map-config");
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain(JS_KEY);
    }
    expect((await accessRows()).filter((e) => e.action === "geo.map_config").map((e) => e.outcome)).toEqual(["denied", "denied"]);
  });

  it("needs a fresh passkey to save, never comes back but as a hint, and rides beside the REST key", async () => {
    await boot();
    clock.advance(11 * 60_000);
    const stale = await owner.browser.send("/v1/geo/credentials/kakao/map", { method: "PUT", body: { key: JS_KEY } });
    expect(stale.status).toBe(403);
    await reauth(owner.browser, owner.credentialId);
    await owner.browser.json("/v1/geo/credentials/kakao/map", { method: "PUT", body: { key: JS_KEY } });
    await owner.browser.json("/v1/geo/credentials/kakao", { method: "PUT", body: { restKey: KAKAO_KEY } });
    const status = await owner.browser.json("/v1/geo");
    expect(JSON.stringify(status)).not.toContain(JS_KEY);
    expect(status.credentials).toEqual([expect.objectContaining({ provider: "kakao", status: "ok", kinds: { restKey: "cdef", jsKey: "c123" } })]);
    expect(status.active).toEqual({ provider: "kakao", source: "own" });

    clock.advance(11 * 60_000);
    expect((await owner.browser.send("/v1/geo/credentials/kakao/map", { method: "DELETE" })).status).toBe(200);
    expect((await owner.browser.json("/v1/geo")).credentials[0].kinds).toEqual({ restKey: "cdef" });
    await reauth(owner.browser, owner.credentialId);
    await owner.browser.json("/v1/geo/credentials/kakao/map", { method: "PUT", body: { key: JS_KEY } });
    await owner.browser.json("/v1/geo/credentials/kakao", { method: "DELETE" });
    await owner.browser.json("/v1/geo/credentials/kakao/map", { method: "PUT", body: { key: JS_KEY } });
    await owner.browser.json("/v1/geo/credentials/kakao/map", { method: "DELETE" });
    expect((await owner.browser.json("/v1/geo")).credentials).toEqual([]);
  });

  it("reports the REST keys and the map key apart, and removing the REST keys keeps the map key", async () => {
    await boot();
    await settings({ geoEnabled: true });
    await owner.browser.json("/v1/geo/credentials/kakao/map", { method: "PUT", body: { key: JS_KEY } });
    const row = async () => (await owner.browser.json("/v1/geo")).credentials[0];
    expect(await row()).toMatchObject({ rest: false, map: true });
    expect((await owner.browser.send("/v1/geo/credentials/kakao", { method: "DELETE" })).status).toBe(404);
    await owner.browser.json("/v1/geo/credentials/kakao", { method: "PUT", body: { restKey: KAKAO_KEY } });
    expect(await row()).toMatchObject({ rest: true, map: true });
    expect((await owner.browser.send("/v1/geo/credentials/kakao", { method: "DELETE" })).status).toBe(200);
    expect(await row()).toMatchObject({ rest: false, map: true, kinds: { jsKey: "c123" } });
    expect((await mapConfig()).provider).toBe("kakao");
  });

  it("keeps how the REST key last fared when the map key is saved or removed, and removing no map key changes nothing", async () => {
    await boot();
    await owner.browser.json("/v1/geo/credentials/kakao", { method: "PUT", body: { restKey: KAKAO_KEY } });
    await settings({ geoEnabled: true });
    expect((await owner.browser.json("/v1/geo/credentials/kakao/test", { method: "POST" })).test.ok).toBe(true);
    const before = (await owner.browser.json("/v1/geo")).credentials[0];
    expect(before.lastUsedAt).not.toBeNull();
    clock.advance(60_000);
    const unchanged = await owner.browser.json("/v1/geo/credentials/kakao/map", { method: "DELETE" });
    expect(unchanged.credential).toEqual(before);
    await owner.browser.json("/v1/geo/credentials/kakao/map", { method: "PUT", body: { key: JS_KEY } });
    await owner.browser.json("/v1/geo/credentials/kakao/map", { method: "DELETE" });
    expect((await owner.browser.json("/v1/geo")).credentials[0]).toMatchObject({ lastUsedAt: before.lastUsedAt, lastError: null, map: false });
  });

  it("saves the REST keys and the map key side by side when both arrive at once", async () => {
    await boot();
    for (let round = 0; round < 5; round++) {
      await Promise.all([
        owner.browser.json("/v1/geo/credentials/kakao", { method: "PUT", body: { restKey: KAKAO_KEY } }),
        owner.browser.json("/v1/geo/credentials/kakao/map", { method: "PUT", body: { key: JS_KEY } }),
      ]);
      expect(await ctx.system.geo.status(owner.userId as never).then((s) => s.credentials[0]), `round ${round}`).toMatchObject({ rest: true, map: true });
      await Promise.all([
        owner.browser.json("/v1/geo/credentials/kakao", { method: "DELETE" }),
        owner.browser.json("/v1/geo/credentials/kakao/map", { method: "DELETE" }),
      ]);
      expect((await owner.browser.json("/v1/geo")).credentials, `round ${round}`).toEqual([]);
    }
  });

  it("refuses a key that could break out of the script URL", async () => {
    await boot();
    for (const key of ["short", "abc&callback=evil123", "abc\"onload=x12345", "x".repeat(129)]) {
      expect((await owner.browser.send("/v1/geo/credentials/kakao/map", { method: "PUT", body: { key } })).status, key).toBe(400);
    }
    expect((await owner.browser.send("/v1/geo/credentials/kakao/map", { method: "PUT", body: { key: JS_KEY, extra: 1 } })).status).toBe(400);
  });

  it("follows the chosen provider, and loads Naver's script by its key id", async () => {
    await boot();
    await settings({ geoEnabled: true, geoProvider: "naver" });
    await owner.browser.json("/v1/geo/credentials/kakao/map", { method: "PUT", body: { key: JS_KEY } });
    expect(await mapConfig()).toEqual({ provider: null });
    await owner.browser.json("/v1/geo/credentials/naver/map", { method: "PUT", body: { key: "naverkeyid01" } });
    expect(await mapConfig()).toMatchObject({
      provider: "naver",
      sdkUrl: "https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=naverkeyid01",
    });
    await settings({ geoProvider: null });
    expect((await mapConfig()).provider).toBe("kakao");
  });

  it("falls back to the operator's map key for USER_ID only, unless every person may use the operator's map keys", async () => {
    await boot({ operatorMapKeys: { kakao: OPERATOR_JS } });
    await settings({ geoEnabled: true });
    expect(await mapConfig()).toMatchObject({ provider: "kakao", sdkUrl: expect.stringContaining(`appkey=${OPERATOR_JS}&`) });
    expect((await owner.browser.json("/v1/geo")).map).toEqual({ provider: "kakao", source: "operator" });
    const mina = await invite("Mina");
    await mina.browser.json("/v1/privacy", { method: "PUT", body: { geoEnabled: true } });
    expect(await mapConfig(mina)).toEqual({ provider: null });
    await owner.browser.json("/v1/geo/credentials/kakao/map", { method: "PUT", body: { key: JS_KEY } });
    expect(await mapConfig()).toMatchObject({ sdkUrl: expect.stringContaining(`appkey=${JS_KEY}&`) });

    // Everyone may use the operator's REST keys; that alone does not hand out its map key.
    await boot({ operatorMapKeys: { kakao: OPERATOR_JS }, operatorKeyForAll: true });
    const ana = await invite("Ana");
    await ana.browser.json("/v1/privacy", { method: "PUT", body: { geoEnabled: true } });
    expect(await mapConfig(ana)).toEqual({ provider: null });
    expect((await ana.browser.json("/v1/geo")).operatorMap).toEqual([]);

    await boot({ operatorMapKeys: { kakao: OPERATOR_JS }, operatorMapKeyForAll: true });
    const bo = await invite("Bo");
    await bo.browser.json("/v1/privacy", { method: "PUT", body: { geoEnabled: true } });
    expect(await mapConfig(bo)).toMatchObject({ provider: "kakao", sdkUrl: expect.stringContaining(`appkey=${OPERATOR_JS}&`) });
    expect((await bo.browser.json("/v1/geo")).active).toBeNull();
  });

  it("uses the person's own key for any provider before the operator's key for the first provider", async () => {
    await boot({ operatorMapKeys: { kakao: OPERATOR_JS } });
    await settings({ geoEnabled: true, geoProvider: null });
    await owner.browser.json("/v1/geo/credentials/naver/map", { method: "PUT", body: { key: "naverkeyid01" } });
    expect(await mapConfig()).toMatchObject({ provider: "naver", sdkUrl: expect.stringContaining("ncpKeyId=naverkeyid01") });
    expect((await owner.browser.json("/v1/geo")).map).toEqual({ provider: "naver", source: "own" });
    await owner.browser.json("/v1/geo/credentials/naver", { method: "PUT", body: { clientId: "naver-client-id-0001", clientSecret: "naver-client-secret-01" } });
    expect((await owner.browser.json("/v1/geo")).active).toEqual({ provider: "naver", source: "own" });
    // A chosen provider is still the only one tried.
    await settings({ geoProvider: "kakao" });
    expect(await mapConfig()).toMatchObject({ provider: "kakao", sdkUrl: expect.stringContaining(`appkey=${OPERATOR_JS}&`) });
    expect((await owner.browser.json("/v1/geo")).active).toEqual({ provider: "kakao", source: "operator" });
  });

});

describe("the owner's own location, for the Home map", () => {
  beforeEach(() => boot());

  it("is the owner's to read in the dashboard whatever the agent policy says, and goes unrecorded; agents stay gated", async () => {
    await ingest(HOME);
    await settings({ defaultAgentAccess: "hidden" });
    const mine = await owner.browser.json("/v1/presence/precise");
    expect(mine).toMatchObject({ lat: HOME.lat, lon: HOME.lon });
    const agent = await as(AGENT, "/v1/presence/precise?reason=pick%20up");
    expect(agent.status).toBe(403);
    expect(await agent.text()).not.toContain(String(HOME.lon));
    expect((await accessRows()).map((e) => [e.action, e.outcome])).toEqual([["presence.precise", "hidden"]]);
  });

  it("reads coarse and precise alike whatever the agent policy, while a token gets each refusal it got before", async () => {
    await ingest(AWAY);
    const cases: [Record<string, unknown>, number, RegExp][] = [
      [{ defaultAgentAccess: "hidden" }, 403, /hidden from agents/],
      [{ defaultAgentAccess: "precise", allowPreciseLocation: false }, 200, /allowPreciseLocation=false/],
      [{ allowPreciseLocation: true, preciseRequiresReason: true }, 200, /reason is required/],
      [{ defaultAgentAccess: "coarse", preciseRequiresReason: false, preciseRequiresApproval: true }, 200, /interactive approval/],
    ];
    for (const [patch, agentCoarse, refusal] of cases) {
      await settings(patch);
      const label = JSON.stringify(patch);
      expect((await owner.browser.send("/v1/presence")).status, label).toBe(200);
      expect(await owner.browser.json("/v1/presence/precise"), label).toMatchObject({ lat: AWAY.lat, lon: AWAY.lon });
      expect((await as(AGENT, "/v1/presence")).status, label).toBe(agentCoarse);
      const precise = await as(AGENT, "/v1/presence/precise");
      expect(precise.status, label).toBe(403);
      expect(JSON.stringify(await precise.json()), label).toMatch(refusal);
    }
    await settings({ preciseRequiresApproval: false, hideHomeExactCoordinates: true });
    await ingest(HOME);
    expect(await owner.browser.json("/v1/presence/precise")).toMatchObject({ lat: HOME.lat, lon: HOME.lon });
    const atHome = await as(AGENT, "/v1/presence/precise?reason=pick%20up");
    expect(atHome.status).toBe(403);
    expect(await atHome.text()).toMatch(/protected by policy/);
  });

  it("says when the owner is near home while the provider is kept away from there, so the map shows the home place", async () => {
    await ingest({ lat: HOME.lat + 0.001, lon: HOME.lon });
    await settings({ skipProviderNearHome: true });
    expect(await owner.browser.json("/v1/presence/precise")).toMatchObject({
      lat: HOME.lat + 0.001,
      nearHome: { name: "home", lat: HOME.lat, lon: HOME.lon, radiusM: 150 },
    });
    await settings({ skipProviderNearHome: false });
    expect(await owner.browser.json("/v1/presence/precise")).not.toHaveProperty("nearHome");
    await settings({ skipProviderNearHome: true });
    await ingest(AWAY);
    expect(await owner.browser.json("/v1/presence/precise")).not.toHaveProperty("nearHome");
  });
});
