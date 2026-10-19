import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { AppContext } from "../app/context.js";
import type { WhereCtxConfig } from "../config.js";
import { OWNER_ADMIN, TestClock, bootApp, reauth, setupOwner, type Enrolled } from "../testing/accounts.js";
import type { FakeGeoProvider } from "../geo/fake.js";
import { GEO_CALLS_PER_MINUTE, KEY_TEST_POINT } from "../geo/service.js";

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
      [String(KEY_TEST_POINT.lat), String(KEY_TEST_POINT.lon)],
    ]);
    expect((await owner.browser.json("/v1/geo")).credentials[0].lastUsedAt).not.toBeNull();
  });
});

describe("search", () => {
  beforeEach(() => boot());

  it("needs manage_places; the owner and an admin token get coordinates", async () => {
    expect((await as(AGENT, "/v1/geo/search?q=강남역")).status).toBe(403);
    const mine = await owner.browser.json("/v1/geo/search?q=강남역");
    expect(mine.candidates[0]).toMatchObject({ label: "강남역 2호선", lat: 37.4979, lon: 127.0276 });
    expect((await as(OWNER_ADMIN, "/v1/geo/search?q=강남역")).status).toBe(200);
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
    expect(((await res.json()) as any).detail).toMatch(/etaToAgents/);
    await settings({ etaToAgents: true, defaultAgentAccess: "hidden" });
    res = await eta(AGENT, "to=office");
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).privacy).toBe("hidden");
    expect(routeCalls()).toEqual([]);
    expect((await eta(null, "to=office")).status).toBe(200);
  });

  it("answers agents with no coordinates, and sends the origin rounded", async () => {
    await settings({ geoEnabled: true, etaToAgents: true });
    const res = await eta(AGENT, "to=office");
    expect(res.status).toBe(200);
    const text = await res.text();
    const { eta: answer } = JSON.parse(text);
    expect(answer).toMatchObject({ destination: { label: "office", kind: "place" }, origin: "current_location", trafficAware: true, provider: "kakao" });
    expect(answer.durationMin).toBeGreaterThan(0);
    expect(answer).not.toHaveProperty("deepLinks");
    for (const n of [AWAY.lat, AWAY.lon, 37.567, 126.978, 37.4, 127.1]) expect(text).not.toContain(String(n));
    expect(routeCalls()[0]!.origin).toEqual({ lat: 37.567, lon: 126.978 });
  });

  it("gives map links to the owner and to a place manager, and for an address the agent named", async () => {
    await settings({ geoEnabled: true, etaToAgents: true });
    expect((await owner.browser.json("/v1/geo/eta?to=office")).eta.deepLinks.kakaoMap).toBe(
      "https://map.kakao.com/link/to/office,37.4,127.1",
    );
    expect((await (await eta(OWNER_ADMIN, "to=office")).json() as any).eta.deepLinks.naverMap).toMatch(/^nmap:\/\/navigation\?dlat=37\.4&dlng=127\.1&dname=office&appname=/);
    const byAddress = (await (await eta(AGENT, "to=" + encodeURIComponent("강남역"))).json()) as any;
    expect(byAddress.eta.destination).toEqual({ label: "강남역 2호선", kind: "address" });
    expect(byAddress.eta.deepLinks.kakaoMap).toContain("37.4979,127.0276");
  });

  it("asks which one when a search finds several", async () => {
    await settings({ geoEnabled: true, etaToAgents: true });
    const res = await eta(AGENT, "to=" + encodeURIComponent("판교역"));
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.candidates.map((c: any) => c.label)).toEqual(["판교역 신분당선", "판교역 경강선"]);
    expect(body.candidates[0]).not.toHaveProperty("lat");
    expect((await eta(AGENT, "to=" + encodeURIComponent("판교역") + "&pick=2")).status).toBe(200);
  });

  it("starts from the home place near home, not the live reading", async () => {
    await settings({ geoEnabled: true });
    await ingest({ lat: 37.5011234, lon: 127.0004321 });
    const { eta: answer } = await owner.browser.json("/v1/geo/eta?to=office");
    expect(answer.origin).toBe("home");
    expect(routeCalls().at(-1)!.origin).toEqual(HOME);
  });

  it("says the location is stale instead of timing a route from it", async () => {
    await settings({ geoEnabled: true, etaToAgents: true });
    clock.advance(16 * 60_000);
    const res = await eta(AGENT, "to=office");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "location is stale", updatedAgoSec: 960 });
    expect(routeCalls()).toEqual([]);
  });

  it("is limited per caller per minute", async () => {
    await settings({ geoEnabled: true, etaToAgents: true });
    for (let i = 0; i < GEO_CALLS_PER_MINUTE; i++) expect((await eta(AGENT, "to=office")).status).toBe(200);
    expect((await eta(AGENT, "to=office")).status).toBe(429);
    expect((await eta(null, "to=office")).status).toBe(200);
    clock.advance(61_000);
    await ingest(AWAY);
    expect((await eta(AGENT, "to=office")).status).toBe(200);
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
    expect(row).toMatchObject({ outcome: "denied", denial: expect.stringContaining("quota") });
  });
});
