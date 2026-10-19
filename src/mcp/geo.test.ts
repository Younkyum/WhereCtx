import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AppContext } from "../app/context.js";
import { resolveTokenPrincipal } from "../auth/principal.js";
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

async function connectAs(secret: string): Promise<Client> {
  const principal = (await resolveTokenPrincipal(ctx, secret))!;
  const server = buildMcpServer(ctx.forUser(principal.userId), principal, ctx);
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await client.connect(clientT);
  return client;
}

async function call(secret: string, name: string, args: Record<string, unknown>): Promise<{ text: string; body: any; isError: boolean }> {
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
    geo: { operatorKeys: { kakao: { provider: "kakao", restKey: "operator-kakao-key-0000" } }, operatorKeyForAll: false, fake: true },
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

  it("answer drive time without any coordinates; directions add the steps", async () => {
    await settings({ geoEnabled: true, etaToAgents: true });
    const eta = await call(AGENT, "get_eta", { to: "office" });
    expect(eta.isError).toBe(false);
    expect(eta.body).toMatchObject({ destination: { label: "office", kind: "place" }, trafficAware: true, provider: "kakao" });
    expect(eta.body).not.toHaveProperty("steps");
    const directions = await call(AGENT, "get_directions", { to: "office" });
    expect(directions.body.steps.length).toBeGreaterThan(0);
    for (const text of [eta.text, directions.text]) {
      for (const n of ["37.566", "37.567", "126.978", "37.4,", "127.1"]) expect(text).not.toContain(n);
    }
  });

  it("are hidden in hidden mode and report a stale location instead of guessing", async () => {
    await settings({ geoEnabled: true, etaToAgents: true });
    clock.advance(16 * 60_000);
    const stale = await call(AGENT, "get_eta", { to: "office" });
    expect(stale.body.error).toMatch(/stale.*16 min ago/);
    await settings({ defaultAgentAccess: "hidden" });
    expect((await call(AGENT, "get_eta", { to: "office" })).body).toEqual({ hidden: true });
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

describe("create_place by address", () => {
  it("geocodes an unambiguous address and never returns its coordinates", async () => {
    const res = await call(AGENT, "create_place", { name: "gangnam", type: "custom", address: "강남역" });
    expect(res.body).toEqual({ name: "gangnam", type: "custom", radiusM: 150, address: "서울 강남구 강남대로 396" });
    expect(res.text).not.toContain("37.4979");
    const place = (await owner.browser.json("/v1/places")).places.find((p: any) => p.name === "gangnam");
    expect(place).toMatchObject({ lat: 37.4979, lon: 127.0276 });
  });

  it("returns numbered candidates without coordinates when several match, then takes a pick", async () => {
    const first = await call(AGENT, "create_place", { name: "pangyo", type: "custom", address: "판교역" });
    expect(first.body.ambiguous).toBe(true);
    expect(first.body.candidates.map((c: any) => c.pick)).toEqual([1, 2]);
    expect(first.text).not.toContain("37.39");
    expect((await owner.browser.json("/v1/places")).places.map((p: any) => p.name)).not.toContain("pangyo");
    const second = await call(AGENT, "create_place", { name: "pangyo", type: "custom", address: "판교역", pick: 2 });
    expect(second.body.name).toBe("pangyo");
  });

  it("wants exactly one of a point or an address", async () => {
    expect((await call(AGENT, "create_place", { name: "x", type: "custom" })).isError).toBe(true);
    expect((await call(AGENT, "create_place", { name: "x", type: "custom", lat: 37, lon: 127, address: "강남역" })).isError).toBe(true);
    expect((await call(AGENT, "create_place", { name: "x", type: "custom", lat: 37 })).isError).toBe(true);
  });

  it("keeps home place protection", async () => {
    const res = await call(AGENT, "create_place", { name: "home", type: "home", address: "강남역" });
    expect(res.body.error).toMatch(/manage_places/);
    expect(fake.calls).toEqual([]);
  });
});
