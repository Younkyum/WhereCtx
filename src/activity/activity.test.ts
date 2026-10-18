import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AppContext } from "../app/context.js";
import { resolveTokenPrincipal } from "../auth/principal.js";
import { REST_ACTIONS, restActionFor } from "../api/accessAudit.js";
import { ACCESS_ACTIONS } from "./types.js";
import { eventsRouter } from "../api/events.js";
import { placesRouter } from "../api/places.js";
import { presenceRouter } from "../api/presence.js";
import { buildMcpServer } from "../mcp/server.js";
import { Browser, TestClock, bootApp, setupOwner, signUpByInvite, type Enrolled } from "../testing/accounts.js";

const HOME = { lat: 37.5, lon: 127.0 };
const DAY = 86_400_000;

let clock: TestClock;
let ctx: AppContext;
let app: Hono;
let owner: Enrolled;
let mina: { browser: Browser; userId: string };
let agent: string;

async function mint(browser: Browser, name: string, role = "agent"): Promise<{ id: string; secret: string }> {
  const r = await browser.json("/v1/tokens", { body: { name, role } });
  return { id: r.token.id, secret: r.secret };
}

/** Each call a millisecond after the last, so newest-first order is the call order. */
const asToken = (path: string, secret: string, init: RequestInit = {}) => {
  clock.advance(1);
  return app.request(path, { ...init, headers: { authorization: `Bearer ${secret}`, ...(init.headers ?? {}) } });
};

async function accessOf(browser: Browser, query = ""): Promise<any> {
  return browser.json(`/v1/activity/access${query}`);
}

beforeEach(async () => {
  clock = new TestClock();
  const booted = await bootApp(clock);
  ({ ctx, app } = booted);
  owner = await setupOwner(app, booted.setupCode);
  const ws = (await owner.browser.json("/v1/workspaces")).workspaces[0].id;
  const { url } = await owner.browser.json(`/v1/workspaces/${ws}/invites`, { body: { role: "member" } });
  const joined = await signUpByInvite(app, url, "Mina");
  mina = { browser: joined.browser, userId: ((await joined.res.json()) as any).userId };
  await owner.browser.json("/v1/places", { body: { name: "home", type: "home", ...HOME, radiusM: 100 } });
  await owner.browser.json("/v1/ingest", { body: { source: "manual", lat: HOME.lat + 0.01, lon: HOME.lon } });
  agent = (await mint(owner.browser, "Claude Desktop")).secret;
});

describe("REST access log", () => {
  it("records each agent read with the token's name, surface and outcome", async () => {
    expect((await asToken("/v1/presence", agent)).status).toBe(200);
    expect((await asToken("/v1/places", agent)).status).toBe(200);
    expect((await asToken("/v1/events", agent)).status).toBe(200);
    expect((await asToken("/v1/presence/precise?reason=find%20me", agent)).status).toBe(403);

    const { entries } = await accessOf(owner.browser);
    expect(entries.map((e: any) => [e.action, e.outcome])).toEqual([
      ["presence.precise", "denied"],
      ["events.list", "allowed"],
      ["places.list", "allowed"],
      ["presence.read", "allowed"],
    ]);
    const precise = entries[0];
    expect(precise).toMatchObject({
      credential: { kind: "token", name: "Claude Desktop" },
      surface: "rest",
      precise: true,
      reason: "find me",
    });
    expect(precise.denial).toMatch(/precise location denied/);
  });

  it("records hidden mode as hidden", async () => {
    await owner.browser.json("/v1/privacy", { method: "PUT", body: { defaultAgentAccess: "hidden" } });
    expect((await asToken("/v1/presence", agent)).status).toBe(403);
    const [entry] = (await accessOf(owner.browser)).entries;
    expect(entry).toMatchObject({ action: "presence.read", outcome: "hidden" });
  });

  it("records a scope refusal as denied", async () => {
    const device = (await mint(owner.browser, "Phone", "device")).secret;
    expect((await asToken("/v1/presence", device)).status).toBe(403);
    const [entry] = (await accessOf(owner.browser)).entries;
    expect(entry).toMatchObject({ action: "presence.read", outcome: "denied", credential: { name: "Phone" } });
    expect(entry.denial).toMatch(/read_presence/);
  });

  it("does not record the owner's own session reads", async () => {
    await owner.browser.json("/v1/presence");
    await owner.browser.json("/v1/places");
    await owner.browser.json("/v1/events");
    await owner.browser.json("/v1/presence/history");
    expect((await accessOf(owner.browser)).entries).toEqual([]);
  });

  it("names an action for every route on the audited routers", () => {
    const routes = [
      ...presenceRouter(ctx).routes.map((r) => ({ ...r, base: "/v1/presence" })),
      ...placesRouter(ctx).routes.map((r) => ({ ...r, base: "/v1/places" })),
      ...eventsRouter().routes.map((r) => ({ ...r, base: "/v1/events" })),
    ].filter((r) => r.method !== "ALL");
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) {
      const path = (r.base + r.path).replace(/:[^/]+/g, "x").replace(/\/$/, "");
      expect(REST_ACTIONS.some((a) => a.method === r.method && a.path.test(path)), `${r.method} ${path}`).toBe(true);
    }
    expect(restActionFor("GET", "/v1/presence/")).toEqual({ action: "presence.read", precise: false });
  });

  it("serves the request even when the log write fails", async () => {
    vi.spyOn(ctx.system.accessLog, "record").mockRejectedValueOnce(new Error("disk full"));
    expect((await asToken("/v1/presence", agent)).status).toBe(200);
  });
});

describe("MCP access log", () => {
  const ARGS: Record<string, Record<string, unknown>> = {
    get_presence: {},
    get_precise_location: { reason: "pick me up" },
    is_near_place: { name: "home" },
    list_places: {},
    get_location_age: {},
    list_recent_presence_events: {},
    create_location_reminder: { place: "home", message: "water the plants" },
    create_place: { name: "gym", type: "custom", lat: 37.51, lon: 127.01 },
    remember_current_place: { name: "here" },
  };

  it("records every tool call through the one registration wrapper", async () => {
    const principal = (await resolveTokenPrincipal(ctx, agent))!;
    const server = buildMcpServer(ctx.forUser(principal.userId), principal, ctx);
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    await client.connect(c);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(ARGS).sort());
    for (const tool of tools) expect(ACCESS_ACTIONS as readonly string[]).toContain(tool.name);
    for (const tool of tools) await client.callTool({ name: tool.name, arguments: ARGS[tool.name]! });

    const { entries } = await accessOf(owner.browser, "?limit=50");
    expect(entries.map((e: any) => e.action).sort()).toEqual(Object.keys(ARGS).sort());
    expect(entries.every((e: any) => e.surface === "mcp" && e.credential.name === "Claude Desktop")).toBe(true);
    const precise = entries.find((e: any) => e.action === "get_precise_location");
    expect(precise).toMatchObject({ precise: true, reason: "pick me up", outcome: "denied" });
    expect(entries.find((e: any) => e.action === "get_presence").outcome).toBe("allowed");
  });

  it("records hidden mode on a tool as hidden", async () => {
    await owner.browser.json("/v1/privacy", { method: "PUT", body: { defaultAgentAccess: "hidden" } });
    const principal = (await resolveTokenPrincipal(ctx, agent))!;
    const server = buildMcpServer(ctx.forUser(principal.userId), principal, ctx);
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    await client.connect(c);
    await client.callTool({ name: "get_presence", arguments: {} });
    const [entry] = (await accessOf(owner.browser)).entries;
    expect(entry).toMatchObject({ action: "get_presence", outcome: "hidden" });
  });
});

describe("GET /v1/activity/access", () => {
  it("shows each person only their own log", async () => {
    await asToken("/v1/presence", agent);
    const minaAgent = (await mint(mina.browser, "Mina's bot")).secret;
    await asToken("/v1/places", minaAgent);
    const mine = (await accessOf(owner.browser)).entries;
    const hers = (await accessOf(mina.browser)).entries;
    expect(mine.map((e: any) => e.credential.name)).toEqual(["Claude Desktop"]);
    expect(hers.map((e: any) => e.credential.name)).toEqual(["Mina's bot"]);
  });

  it("refuses tokens, even the owner's admin token", async () => {
    const admin = (await mint(owner.browser, "admin", "admin")).secret;
    expect((await asToken("/v1/activity/access", admin)).status).toBe(403);
    expect((await asToken("/v1/activity/access", agent)).status).toBe(403);
  });

  it("is not cached", async () => {
    const res = await owner.browser.send("/v1/activity/access");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("pages with the next cursor and filters by credential", async () => {
    const other = await mint(owner.browser, "Other bot");
    for (let i = 0; i < 3; i++) await asToken("/v1/presence", agent);
    await asToken("/v1/presence", other.secret);
    const first = await accessOf(owner.browser, "?limit=2");
    expect(first.entries).toHaveLength(2);
    const second = await accessOf(owner.browser, `?limit=2&before=${encodeURIComponent(first.next)}`);
    expect(second.entries).toHaveLength(2);
    expect(second.next).toBeUndefined();
    const ids = [...first.entries, ...second.entries].map((e: any) => e.id);
    expect(new Set(ids).size).toBe(4);
    const filtered = await accessOf(owner.browser, `?credential=${other.id}`);
    expect(filtered.entries.map((e: any) => e.credential.name)).toEqual(["Other bot"]);
  });
});

describe("retention", () => {
  it("prunes rows older than the retention window", async () => {
    await asToken("/v1/presence", agent);
    clock.advance(10 * DAY);
    await asToken("/v1/places", agent);
    expect(await ctx.system.accessLog.prune(5)).toBe(1);
    expect((await accessOf(owner.browser)).entries.map((e: any) => e.action)).toEqual(["places.list"]);
  });
});
