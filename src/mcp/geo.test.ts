import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AppContext } from "../app/context.js";
import { resolveTokenPrincipal, type McpPrincipal } from "../auth/principal.js";
import type { FakeGeoProvider } from "../geo/fake.js";
import { OWNER_ADMIN, TestClock, bootApp, setupOwner, type Enrolled } from "../testing/accounts.js";
import { buildMcpServer } from "./server.js";

const AGENT = "agent-token-strong-0123456789abcdef-mcp";
const HOME = { lat: 37.5, lon: 127.0 };
const AWAY = { lat: 37.5665432, lon: 126.9784321 };

let clock: TestClock;
let ctx: AppContext;
let app: Hono;
let owner: Enrolled;
let fake: FakeGeoProvider;

async function connectAs(secret: string | McpPrincipal): Promise<Client> {
  const principal = typeof secret === "string" ? (await resolveTokenPrincipal(ctx, secret))! : secret;
  const server = buildMcpServer(ctx.forUser(principal.userId), principal, ctx);
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await client.connect(clientT);
  return client;
}

async function call(secret: string | McpPrincipal, name: string, args: Record<string, unknown>): Promise<{ text: string; body: any; isError: boolean }> {
  const res = (await (await connectAs(secret)).callTool({ name, arguments: args })) as any;
  const text = res.content[0].text as string;
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { text, body, isError: Boolean(res.isError) };
}

const settings = (body: Record<string, unknown>) => owner.browser.json("/v1/privacy", { method: "PUT", body });

beforeEach(async () => {
  clock = new TestClock();
  const booted = await bootApp(clock, {
    bootstrapTokens: { admin: OWNER_ADMIN, agent: AGENT },
    geo: { operatorMapKeys: {}, operatorKeys: { kakao: { provider: "kakao", restKey: "operator-kakao-key-0000" } }, operatorKeyForAll: false, fake: true },
  });
  ({ ctx, app } = booted);
  fake = ctx.system.geo.fake!;
  owner = await setupOwner(app, booted.setupCode);
  await owner.browser.json("/v1/places", { body: { name: "home", type: "home", ...HOME, radiusM: 150 } });
  await owner.browser.json("/v1/places", { body: { name: "office", type: "work", lat: 37.4, lon: 127.1, radiusM: 150 } });
  await owner.browser.json("/v1/ingest", { body: { source: "manual", ...AWAY } });
  await ctx.system.geo.settled();
});

afterEach(async () => {
  await ctx.system.geo.settled();
  ctx.handle.client.close();
});

describe("get_eta and get_directions", () => {
  it("are refused until the user turns on ETA for agents, and send nothing", async () => {
    await settings({ geoEnabled: true });
    const res = await call(AGENT, "get_eta", { to: "office" });
    expect(res.isError).toBe(true);
    expect(res.body.error).toMatch(/etaToAgents/);
    expect(fake.calls.filter((c) => c.op === "route")).toEqual([]);
  });

  it("answer drive time without any coordinates; steps only with precise access and a reason", async () => {
    await settings({ geoEnabled: true, etaToAgents: true });
    const eta = await call(AGENT, "get_eta", { to: "office" });
    expect(eta.isError).toBe(false);
    expect(eta.body).toMatchObject({ destination: { label: "office", kind: "place" }, precision: "approximate", traffic: "live", provider: "kakao" });
    expect(eta.body).not.toHaveProperty("steps");
    const withheld = await call(AGENT, "get_directions", { to: "office", reason: "pick-up" });
    expect(withheld.body).not.toHaveProperty("steps");
    expect(withheld.body.stepsWithheld).toMatch(/precise access/);
    // The fake's first stretch and first turn name the street the route starts on.
    for (const text of [eta.text, withheld.text]) {
      expect(text).not.toContain("테스트출발로12번길");
      expect(text).not.toContain("테스트도착로");
      for (const n of ["37.566", "37.567", "126.978", "37.4,", "127.1"]) expect(text).not.toContain(n);
    }

    await settings({ allowPreciseLocation: true });
    expect((await call(AGENT, "get_directions", { to: "office" })).body).toHaveProperty("stepsWithheld");
    const directions = await call(AGENT, "get_directions", { to: "office", reason: "pick-up" });
    expect(directions.body.steps[0]).toContain("테스트출발로12번길");
  });

  it("never carry the route's geometry, for a token or an OAuth client, however much they may see", async () => {
    await settings({ geoEnabled: true, etaToAgents: true, allowPreciseLocation: true, preciseRequiresReason: false });
    const oauth: McpPrincipal = {
      via: "oauth",
      userId: owner.userId,
      scopes: ["read_presence", "read_precise_location", "manage_places"],
      grantId: "grant-1",
      clientId: "https://client.example/meta.json",
      clientName: "Client",
    };
    for (const who of [AGENT, OWNER_ADMIN, oauth]) {
      for (const tool of ["get_eta", "get_directions"]) {
        const res = await call(who, tool, { to: "office", reason: "pick-up" });
        expect(res.isError, tool).toBe(false);
        expect(res.body, tool).not.toHaveProperty("path");
        expect(res.body.precision, tool).toBe("approximate");
      }
    }
    expect((await call(oauth, "get_directions", { to: "office", reason: "pick-up" })).body.steps.length).toBeGreaterThan(0);
    expect((await owner.browser.json("/v1/geo/eta?to=office")).eta.path.length).toBeGreaterThan(1);
  });

  it("are hidden in hidden mode and refuse a reading too old to start from", async () => {
    await settings({ geoEnabled: true, etaToAgents: true });
    clock.advance(16 * 60_000);
    const old = await call(AGENT, "get_eta", { to: "office" });
    expect(old.isError).toBe(true);
    expect(old.body).toMatchObject({ freshness: "unknown", originAgeMin: 16 });
    await settings({ defaultAgentAccess: "hidden" });
    expect((await call(AGENT, "get_eta", { to: "office" })).body).toMatchObject({ privacy: "hidden" });
  });

  it("are recorded per call with the provider call beside them, coordinates never", async () => {
    await settings({ geoEnabled: true, etaToAgents: true });
    await call(AGENT, "get_directions", { to: "office" });
    const { entries } = await owner.browser.json("/v1/activity/access");
    // Turning maps on also looked up the area in the background, as the system.
    expect(entries.filter((e: any) => e.credential.kind !== "system").map((e: any) => [e.action, e.surface]).sort()).toEqual([
      ["geo.route", "mcp"],
      ["get_directions", "mcp"],
    ]);
  });
});

describe("get_eta by transit, on foot and by bicycle", () => {
  it("names only the lines ridden away from both ends, never a stop, and records the mode", async () => {
    await settings({ geoEnabled: true, etaToAgents: true });
    const res = await call(AGENT, "get_directions", { to: "office", mode: "transit" });
    expect(res.isError).toBe(false);
    expect(res.body).toMatchObject({ mode: "transit", summary: ["2호선"], transfers: 2, stepsWithheld: expect.any(String) });
    expect(res.text).not.toMatch(/정류장|테스트\S*역|마을 테스트1|간선 472|"fare"|"legs"|"path"/);
    expect(fake.calls.filter((c) => c.op === "route").map((c) => c.op === "route" && c.request.mode)).toEqual(["transit"]);
    const { entries } = await owner.browser.json("/v1/activity/access");
    expect(entries.map((e: any) => e.action)).toContain("geo.route.transit");
  });

  it("answers walk and bike with no street, and refuses an unknown mode", async () => {
    await settings({ geoEnabled: true, etaToAgents: true });
    for (const mode of ["walk", "bike"]) {
      const res = await call(AGENT, "get_eta", { to: "office", mode });
      expect(res.body, mode).toMatchObject({ mode, summary: [] });
      expect(res.text, mode).not.toMatch(/테스트\S*로/);
    }
    expect((await call(AGENT, "get_eta", { to: "office", mode: "boat" })).isError).toBe(true);
  });
});

describe("create_place by address", () => {
  beforeEach(() => settings({ geoEnabled: true }));

  it("geocodes an unambiguous address and never returns its coordinates", async () => {
    const res = await call(OWNER_ADMIN, "create_place", { name: "gangnam", type: "custom", address: "강남역" });
    expect(res.body).toEqual({ name: "gangnam", type: "custom", radiusM: 150, address: "서울 강남구 강남대로 396" });
    const place = (await owner.browser.json("/v1/places")).places.find((p: any) => p.name === "gangnam");
    expect(place).toMatchObject({ lat: 37.4979, lon: 127.0276 });
  });

  it("returns numbered candidates when several match, then takes a pick", async () => {
    const first = await call(OWNER_ADMIN, "create_place", { name: "pangyo", type: "custom", address: "판교역" });
    expect(first.body.ambiguous).toBe(true);
    expect(first.body.candidates.map((c: any) => c.pick)).toEqual([1, 2]);
    expect((await owner.browser.json("/v1/places")).places.map((p: any) => p.name)).not.toContain("pangyo");
    const second = await call(OWNER_ADMIN, "create_place", { name: "pangyo", type: "custom", address: "판교역", pick: 2 });
    expect(second.body.name).toBe("pangyo");
  });

  it("is refused, with nothing sent, without manage_places, in hidden mode, or with maps off", async () => {
    const res = await call(AGENT, "create_place", { name: "gangnam", type: "custom", address: "강남역" });
    expect(res.body.error).toMatch(/manage_places/);
    await settings({ defaultAgentAccess: "hidden" });
    expect((await call(OWNER_ADMIN, "create_place", { name: "gangnam", type: "custom", address: "강남역" })).body).toMatchObject({ privacy: "hidden" });
    await settings({ defaultAgentAccess: "coarse", geoEnabled: false });
    expect((await call(OWNER_ADMIN, "create_place", { name: "gangnam", type: "custom", address: "강남역" })).body.error).toMatch(/geoEnabled/);
    expect(fake.calls.filter((c) => c.op === "geocode")).toEqual([]);
  });

  it("wants exactly one of a point or an address", async () => {
    expect((await call(AGENT, "create_place", { name: "x", type: "custom" })).isError).toBe(true);
    expect((await call(AGENT, "create_place", { name: "x", type: "custom", lat: 37, lon: 127, address: "강남역" })).isError).toBe(true);
    expect((await call(AGENT, "create_place", { name: "x", type: "custom", lat: 37 })).isError).toBe(true);
  });

  it("keeps home place protection", async () => {
    const res = await call(AGENT, "create_place", { name: "home", type: "home", address: "강남역" });
    expect(res.body.error).toMatch(/manage_places/);
    expect(fake.calls.filter((c) => c.op === "geocode")).toEqual([]);
  });
});
