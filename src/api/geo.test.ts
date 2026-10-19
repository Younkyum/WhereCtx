import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { AppContext } from "../app/context.js";
import type { WhereCtxConfig } from "../config.js";
import { OWNER_ADMIN, TestClock, bootApp, reauth, setupOwner, signUpByInvite, type Enrolled } from "../testing/accounts.js";
import type { FakeGeoProvider } from "../geo/fake.js";
import { GEO_USER_CALLS_PER_MINUTE, KEY_TEST_DESTINATION, KEY_TEST_POINT } from "../geo/keys.js";
import { recentLogs } from "../util/log.js";
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
      geo: { operatorKeys: { kakao: { provider: "kakao", restKey: "operator-kakao-key-0000" } }, operatorKeyForAll: false, fake: true, ...geo },
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
  const read = (name: string) => JSON.parse(readFileSync(new URL(`../geo/fixtures/${name}`, import.meta.url), "utf8"));

  /** A provider network that answers each path with a status and a body, and keeps every URL asked for. */
  function network(answers: Record<string, [number, unknown]>) {
    const sent: URL[] = [];
    const fetch = (async (input: URL | string) => {
      const url = new URL(String(input));
      sent.push(url);
      const [status, body] = answers[url.pathname] ?? [404, {}];
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
    return { sent, fetch };
  }

  async function testKakao(answers: Record<string, [number, unknown]>) {
    const net = network(answers);
    await boot({ fake: false }, net.fetch);
    await settings({ geoEnabled: true, skipProviderNearHome: true });
    await ingest(HOME);
    await owner.browser.json("/v1/geo/credentials/kakao", { method: "PUT", body: { restKey: KAKAO_KEY } });
    const res = await owner.browser.send("/v1/geo/credentials/kakao/test", { method: "POST" });
    const text = await res.text();
    return { status: res.status, text, test: JSON.parse(text).test, sent: net.sent };
  }

  it("looks up Seoul City Hall and times a route from it with my key, never where I am, and notes how it went", async () => {
    const { test, sent } = await testKakao({
      "/v2/local/geo/coord2regioncode.json": [200, read("kakao-coord2regioncode.json")],
      "/v1/directions": [200, read("kakao-directions.json")],
    });
    expect(test).toEqual({ ok: true, label: "성남시 분당구 삼평동" });
    expect(sent.map((u) => u.pathname)).toEqual(["/v2/local/geo/coord2regioncode.json", "/v1/directions"]);
    expect([sent[0]!.searchParams.get("y"), sent[0]!.searchParams.get("x")]).toEqual([
      String(roundCoord(KEY_TEST_POINT.lat)),
      String(roundCoord(KEY_TEST_POINT.lon)),
    ]);
    expect(sent[1]!.searchParams.get("origin")).toBe(`${roundCoord(KEY_TEST_POINT.lon)},${roundCoord(KEY_TEST_POINT.lat)}`);
    expect(sent[1]!.searchParams.get("destination")).toBe(`${roundCoord(KEY_TEST_DESTINATION.lon)},${roundCoord(KEY_TEST_DESTINATION.lat)}`);
    expect((await owner.browser.json("/v1/geo")).credentials[0].lastUsedAt).not.toBeNull();
  });

  it("says what Kakao refused and why, in Kakao's words without the key, and stops there", async () => {
    const echoing = { errorType: "AccessDeniedError", message: `appKey(${KAKAO_KEY}) does not exist` };
    const { test, text, sent } = await testKakao({ "/v2/local/geo/coord2regioncode.json": [401, echoing] });
    expect(test).toEqual({
      ok: false,
      error: "auth",
      api: "geocoding",
      code: "key_invalid",
      providerMessage: "appKey(••••) does not exist",
      message: "the maps provider does not know this key",
    });
    expect(text).not.toContain(KAKAO_KEY);
    expect(JSON.stringify(recentLogs())).not.toContain(KAKAO_KEY);
    expect(sent).toHaveLength(1);
  });

  it("names the 카카오맵 product being off, and a Mobility API not enabled", async () => {
    const local = await testKakao({ "/v2/local/geo/coord2regioncode.json": [403, read("kakao-error-map-disabled.json")] });
    expect(local.test).toMatchObject({ ok: false, api: "geocoding", code: "map_service_disabled" });
    const mobility = await testKakao({
      "/v2/local/geo/coord2regioncode.json": [200, read("kakao-coord2regioncode.json")],
      "/v1/directions": [403, { code: -3, msg: "disabled feature" }],
    });
    expect(mobility.test).toMatchObject({ ok: false, api: "directions", code: "service_not_enabled", providerMessage: "disabled feature" });
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

describe("ETA by mode", () => {
  const eta = (token: string | null, query: string) =>
    token ? as(token, `/v1/geo/eta?${query}`) : owner.browser.send(`/v1/geo/eta?${query}`);

  it("times transit for the owner leg by leg, stops and fare included, from a rounded origin", async () => {
    await boot();
    await ingest(AWAY);
    await settings({ geoEnabled: true });
    const { eta: answer } = await owner.browser.json("/v1/geo/eta?to=office&mode=transit");
    expect(answer).toMatchObject({ mode: "transit", precision: "exact", transfers: 2, fare: 1550 });
    expect(answer.legs.map((l: any) => l.kind)).toEqual(["walk", "bus", "subway", "bus", "walk"]);
    expect(answer.legs[1].stops).toEqual(["테스트출발정류장", "테스트환승정류장"]);
    expect(answer).not.toHaveProperty("traffic");
    expect(routeCalls()[0]).toMatchObject({ mode: "transit", origin: { lat: 37.567, lon: 126.978 }, destination: { lat: 37.4, lon: 127.1 } });
  });

  it("gives a token no line when a ride runs near an end (a village bus by the start), no stop, no fare, no coordinate", async () => {
    await boot();
    await ingest(AWAY);
    await settings({ geoEnabled: true, etaToAgents: true });
    const res = await eta(AGENT, "to=office&mode=transit");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).eta).toMatchObject({ mode: "transit", precision: "approximate", summary: [] });
    for (const word of ["정류장", "테스트환승역", "마을 테스트1", "2호선", "간선 472", "transfers", "fare", "legs", "path", "37.567", "126.978"]) expect(text).not.toContain(word);
  });

  it("refuses an unknown mode, and road kinds or a later departure for transit", async () => {
    await boot();
    await ingest(AWAY);
    await settings({ geoEnabled: true });
    expect((await eta(null, "to=office&mode=boat")).status).toBe(400);
    const avoid = await eta(null, "to=office&mode=walk&avoid=toll");
    expect(avoid.status).toBe(502);
    expect(((await avoid.json()) as any).kind).toBe("unsupported");
  });

  it("answers unsupported_mode on Naver, sends nothing, and says which modes it routes", async () => {
    await boot({ operatorKeys: { naver: { provider: "naver", clientId: "operator-naver-id", clientSecret: "operator-naver-secret" } } });
    await ingest(AWAY);
    await settings({ geoEnabled: true, etaToAgents: true });
    for (const who of [null, AGENT]) {
      const res = await eta(who, "to=office&mode=transit");
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ unsupported: "mode", mode: "transit", provider: "naver", supported: ["car"] });
    }
    expect(routeCalls()).toEqual([]);
    expect((await eta(AGENT, "to=office")).status).toBe(200);
    const row = (await accessRows()).find((e) => e.action === "geo.eta" && e.outcome === "error");
    expect(row.denial).toMatch(/naver does not route transit/);
  });
});

describe("map-config: the tiles the dashboard draws on", () => {
  it("names the configured tiles to a signed-in person, maps on or off, with no key in it", async () => {
    await boot();
    const tiles = {
      url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      attribution: "© OpenStreetMap contributors",
      attributionUrl: "https://www.openstreetmap.org/copyright",
    };
    expect(await owner.browser.json("/v1/geo/map-config")).toEqual({ tiles });
    await settings({ geoEnabled: true });
    expect(await owner.browser.json("/v1/geo/map-config")).toEqual({ tiles });
  });

  it("is a session's business: a token is refused and recorded", async () => {
    await boot();
    for (const token of [OWNER_ADMIN, AGENT]) expect((await as(token, "/v1/geo/map-config")).status).toBe(403);
    expect((await accessRows()).filter((e) => e.action === "geo.map_config").map((e) => e.outcome)).toEqual(["denied", "denied"]);
  });

  it("the map key routes are gone", async () => {
    await boot();
    for (const method of ["PUT", "DELETE"]) {
      expect((await owner.browser.send("/v1/geo/credentials/kakao/map", { method, body: { key: "0123456789abcdef" } })).status, method).toBe(404);
    }
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
