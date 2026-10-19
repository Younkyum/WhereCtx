import { beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { WhereCtxConfig } from "../config.js";
import { ROLE_SCOPES, asUserId } from "../types.js";
import { createAppContext, type AppContext } from "../app/context.js";
import { buildApp } from "../app/server.js";
import type { Principal } from "../auth/principal.js";
import { buildMcpServer } from "../mcp/server.js";

const ADMIN = "admin-token-strong-0123456789abcdef";
const AGENT = "agent-token-strong-0123456789abcdef";
const USER = asUserId("default");

const config: WhereCtxConfig = {
  port: 0,
  host: "127.0.0.1",
  baseUrl: "http://localhost:8787",
  databaseUrl: ":memory:",
  defaultUserId: USER,
  bootstrapTokens: { admin: ADMIN, agent: AGENT },
  privacy: {
    defaultAgentAccess: "coarse",
    preciseRequiresReason: true,
    allowPreciseToAgent: false,
    hideHomeExactCoordinates: true,
    protectHomePlace: true,
    staleAfterSec: 900,
    deviceOfflineAfterSec: 86_400,
    retentionHours: 24,
    storeRawHistory: false,
  },
  geofence: { nearRadiusMultiplier: 3 },
  trustProxy: "none",
  allowMemberWorkspaces: true,
  webhooks: { allowPrivateTargets: false },
  events: { retentionHours: 720 },
  sharing: { auditRetentionDays: 365 },
  oauth: { dynamicRegistration: false },
  geo: { operatorKeys: {}, operatorKeyForAll: false, fake: false },
  activity: { accessLogRetentionDays: 90, ingestLogRetentionDays: 7 },
};

/** About 196 m x 137 m; every vertex number is distinctive enough to search a reply for. */
const OFFICE: Array<[number, number]> = [
  [127.012345, 37.567891],
  [127.014567, 37.567891],
  [127.014567, 37.569123],
  [127.012345, 37.569123],
];
const VERTEX_NUMBERS = ["127.012345", "127.014567", "37.567891", "37.569123"];
const INSIDE = { lat: 37.5685, lon: 127.0134 };

let app: Hono;
let ctx: AppContext;

async function req(path: string, opts: { method?: string; token?: string; body?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return app.request(path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

const postPlace = (body: Record<string, unknown>) => req("/v1/places", { method: "POST", token: ADMIN, body });

function expectNoShape(json: string): void {
  for (const n of VERTEX_NUMBERS) expect(json).not.toContain(n);
  for (const key of ['"polygon"', '"lat"', '"lon"', '"radiusM"', '"enterAfterSec"', '"approachM"', '"emits"']) {
    expect(json).not.toContain(key);
  }
}

async function readInside(): Promise<void> {
  await ctx.forUser(USER).presence.processReading({
    precise: { ...INSIDE, accuracyM: 10 },
    motion: "stationary",
    source: "owntracks",
    updatedAt: new Date().toISOString(),
  });
}

async function agentMcp(): Promise<(name: string, args?: Record<string, unknown>) => Promise<string>> {
  const principal: Principal = { via: "token", userId: USER, scopes: ROLE_SCOPES.agent, tokenId: "agent-id", tokenName: "agent" };
  const server = buildMcpServer(ctx.forUser(USER), principal, ctx);
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await client.connect(clientT);
  return async (name, args = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> };
    return res.content[0]!.text;
  };
}

beforeEach(async () => {
  ctx = (await createAppContext(config)).ctx;
  app = buildApp(ctx);
});

describe("POST /v1/places with a polygon", () => {
  it("stores the closed ring, its centroid as the anchor, and the rules", async () => {
    const res = await postPlace({ name: "office", type: "work", polygon: OFFICE, enterAfterSec: 120, approachM: 300 });
    expect(res.status).toBe(201);
    const { place } = (await res.json()) as any;
    expect(place.polygon).toEqual([...OFFICE, OFFICE[0]]);
    expect(place.lon).toBeGreaterThan(127.012345);
    expect(place.lon).toBeLessThan(127.014567);
    expect(place.lat).toBeGreaterThan(37.567891);
    expect(place.lat).toBeLessThan(37.569123);
    expect(place).toMatchObject({ enterAfterSec: 120, exitAfterSec: 0, approachM: 300, notifyWebhooks: true });
  });

  it.each([
    ["a polygon together with lat/lon", { polygon: OFFICE, lat: 37.5, lon: 127 }],
    ["crossing edges", { polygon: [OFFICE[0], OFFICE[2], OFFICE[1], OFFICE[3]] }],
    ["two vertices", { polygon: [OFFICE[0], OFFICE[1]] }],
    ["an enter delay over a day", { lat: 37.5, lon: 127, enterAfterSec: 86_401 }],
    ["an approach ring under 10 m", { lat: 37.5, lon: 127, approachM: 5 }],
    ["an unknown event type", { lat: 37.5, lon: 127, emits: ["presence.updated"] }],
  ])("refuses %s", async (_name, body) => {
    expect((await postPlace({ name: "office", type: "work", ...body })).status).toBe(400);
  });

  it("keeps rules a later write leaves out, and replaces the shape", async () => {
    await postPlace({ name: "office", type: "work", polygon: OFFICE, exitAfterSec: 600, notifyReminders: false });
    const res = await postPlace({ name: "office", type: "work", lat: 37.5, lon: 127.0, radiusM: 200 });
    const { place } = (await res.json()) as any;
    expect(place).not.toHaveProperty("polygon");
    expect(place).toMatchObject({ lat: 37.5, lon: 127.0, radiusM: 200, exitAfterSec: 600, notifyReminders: false });
  });

  it("makes a reading inside the polygon count as being at the place", async () => {
    await postPlace({ name: "office", type: "work", polygon: OFFICE });
    await readInside();
    const presence = (await (await req("/v1/presence", { token: AGENT })).json()) as any;
    expect(presence.status).toBe("work");
  });
});

describe("what agents see of a polygon place", () => {
  beforeEach(async () => {
    await postPlace({ name: "office", type: "custom", polygon: OFFICE, enterAfterSec: 300, approachM: 300 });
    await readInside();
  });

  it("REST lists only names and types to a read_presence token", async () => {
    const res = await req("/v1/places", { token: AGENT });
    const json = await res.text();
    expectNoShape(json);
    expect(JSON.parse(json)).toEqual({ places: [{ name: "office", type: "custom" }] });
  });

  it("MCP list_places, is_near_place and get_presence carry no shape and no rule", async () => {
    const call = await agentMcp();
    const list = await call("list_places");
    expectNoShape(list);

    const near = await call("is_near_place", { name: "office" });
    expectNoShape(near);
    expect(JSON.parse(near)).toMatchObject({ inside: true, confirmed: false, pending: "entering" });

    const presence = await call("get_presence");
    expectNoShape(presence);
    expect(presence).not.toContain("office");
    expect(JSON.parse(presence).transition).toEqual({ kind: "entering", placeType: "custom", forSec: expect.any(Number) });
  });
});
