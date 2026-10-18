import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { WhereCtxConfig } from "../config.js";
import { createAppContext, type AppContext, type UserScope } from "../app/context.js";
import { buildApp } from "../app/server.js";
import { resolveTokenPrincipal } from "../auth/principal.js";
import { buildMcpServer } from "../mcp/server.js";
import { asUserId, type UserId } from "../types.js";
import { WebhookDispatcher } from "../webhooks/dispatcher.js";

const A = asUserId("a");
const B = asUserId("b");

const A_ADMIN = "a-admin-token-strong-0123456789abcdef";
const A_DEVICE = "a-device-token-strong-0123456789abcdef";
const A_AGENT = "a-agent-token-strong-0123456789abcdef";

const HOME = { lat: 37.0, lon: 127.0 };
const ALL_TIME = { from: "0000", to: "9999", limit: 5000 };
const AWAY = { lat: 37.05, lon: 127.0 };

const config: WhereCtxConfig = {
  port: 0,
  host: "127.0.0.1",
  baseUrl: "http://localhost:8787",
  databaseUrl: ":memory:",
  defaultUserId: A,
  bootstrapTokens: { admin: A_ADMIN, device: A_DEVICE, agent: A_AGENT },
  privacy: {
    defaultAgentAccess: "coarse",
    preciseRequiresReason: true,
    allowPreciseToAgent: false,
    hideHomeExactCoordinates: true,
    protectHomePlace: true,
    staleAfterSec: 900,
    retentionHours: 24,
    storeRawHistory: false,
  },
  geofence: { nearRadiusMultiplier: 3 },
  trustProxy: "none",
  allowMemberWorkspaces: true,
  webhooks: { allowPrivateTargets: true },
  events: { retentionHours: 720 },
  sharing: { auditRetentionDays: 365 },
    activity: { accessLogRetentionDays: 90, ingestLogRetentionDays: 7 },
};

interface UserTokens {
  admin: string;
  device: string;
  agent: string;
}

let ctx: AppContext;
let app: Hono;
let a: UserTokens;
let b: UserTokens;
let scopeA: UserScope;
let scopeB: UserScope;

async function req(
  path: string,
  opts: { method?: string; token: string; body?: unknown },
): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${opts.token}` };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return app.request(path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function json(path: string, token: string): Promise<any> {
  const r = await req(path, { token });
  expect(r.status).toBe(200);
  return r.json();
}

async function send(path: string, token: string, body: unknown, method = "POST"): Promise<Response> {
  return req(path, { method, token, body });
}

function ingest(token: string, at: { lat: number; lon: number }): Promise<Response> {
  return send("/v1/ingest", token, at);
}

const tick = () => new Promise((r) => setTimeout(r, 5));

async function tokensFor(userId: UserId): Promise<UserTokens> {
  const scope = ctx.forUser(userId);
  const create = async (role: "admin" | "device" | "agent") => {
    const minted = await scope.tokens.create(`${role}-${userId}`, role);
    if (minted === "limit") throw new Error("token limit reached");
    return minted.secret;
  };
  return { admin: await create("admin"), device: await create("device"), agent: await create("agent") };
}

beforeEach(async () => {
  ctx = (await createAppContext(config)).ctx;
  app = buildApp(ctx);
  scopeA = ctx.forUser(A);
  scopeB = ctx.forUser(B);
  a = { admin: A_ADMIN, device: A_DEVICE, agent: A_AGENT };
  b = await tokensFor(B);
  const r = await send("/v1/places", a.admin, { name: "home", ...HOME, radiusM: 150, type: "home" });
  expect(r.status).toBe(201);
});

afterEach(() => {
  ctx.handle.client.close();
});

/** Everything A's scope can read, for before/after comparisons. */
async function snapshot(scope: UserScope) {
  return {
    places: await scope.places.list(),
    presence: await scope.presence.getCurrent(),
    settings: await scope.settings.getOrSeed(),
    events: await scope.events.listRecent(500),
    history: await scope.history.listRange(ALL_TIME),
    reminders: await scope.reminders.listActive(),
    webhooks: await scope.webhooks.list(),
    deadLetters: await scope.webhooks.listDeadLetters(),
    tokens: await scope.tokens.list(),
  };
}

describe("user scope isolation", () => {
  it("shows B nothing of A's and lets B change nothing of A's", async () => {
    await scopeA.settings.getOrSeed();
    await send("/v1/privacy", a.admin, { storeRawHistory: true }, "PUT");
    await ingest(a.device, HOME);
    await scopeA.reminders.create("home", "A only");
    const hook = await scopeA.webhooks.create({ url: "http://127.0.0.1:9/a", events: ["*"] });
    await ctx.system.webhooks.recordDeadLetter(
      hook.id,
      { id: "e1", type: "presence.updated", createdAt: new Date().toISOString() },
      "status 500",
    );
    const aTokenIds = (await scopeA.tokens.list()).map((t) => t.id);
    const before = await snapshot(scopeA);

    const reads: Array<[string, () => Promise<unknown>, unknown]> = [
      ["places.list", () => scopeB.places.list(), []],
      ["places.count", () => scopeB.places.count(), 0],
      ["places.get", () => scopeB.places.get("home"), null],
      ["presence.getCurrent", () => scopeB.presence.getCurrent(), null],
      ["events.listRecent", () => scopeB.events.listRecent(), []],
      ["history.listRange", () => scopeB.history.listRange(ALL_TIME), { points: [], truncated: false }],
      ["reminders.listActive", () => scopeB.reminders.listActive(), []],
      ["reminders.countActive", () => scopeB.reminders.countActive(), 0],
      ["webhooks.list", () => scopeB.webhooks.list(), []],
      ["webhooks.count", () => scopeB.webhooks.count(), 0],
      ["webhooks.listDeadLetters", () => scopeB.webhooks.listDeadLetters(), []],
      ["presence.reevaluateCurrent", () => scopeB.presence.reevaluateCurrent(), null],
      ["presence.checkStale", () => scopeB.presence.checkStale(), null],
      ["places.deleteByName", () => scopeB.places.deleteByName("home"), false],
      ["webhooks.delete", () => scopeB.webhooks.delete(hook.id), false],
      ...aTokenIds.map(
        (id): [string, () => Promise<unknown>, unknown] => [
          "tokens.revoke",
          () => scopeB.tokens.revoke(id),
          false,
        ],
      ),
    ];
    for (const [name, read, expected] of reads) {
      expect(await read(), name).toEqual(expected);
    }
    expect((await scopeB.tokens.list()).some((t) => aTokenIds.includes(t.id))).toBe(false);
    await scopeB.presence.changePrivacySettings({ defaultAgentAccess: "hidden", protectHomePlace: false });

    expect(await snapshot(scopeA)).toEqual(before);
  });
});

describe("REST isolation between users", () => {
  it("does not show A's presence to B", async () => {
    expect((await ingest(a.device, AWAY)).status).toBe(200);
    expect((await req("/v1/presence", { token: a.agent })).status).toBe(200);
    expect((await req("/v1/presence", { token: b.agent })).status).toBe(404);
  });

  it("does not hand A's precise location to B", async () => {
    await ingest(a.device, AWAY);
    await send("/v1/privacy", b.admin, { allowPreciseLocation: true }, "PUT");
    const r = await req("/v1/presence/precise?reason=map", { token: b.agent });
    expect(r.status).toBe(404);
  });

  it("geofences each ingest against its owner's places and presence only", async () => {
    await ingest(a.device, AWAY);
    const aBefore = await scopeA.presence.getCurrent();
    // B's own home sits where A is now; A's home is where B will be.
    await send("/v1/places", b.admin, { name: "home", ...AWAY, radiusM: 150, type: "home" });
    await tick();

    const r = await ingest(b.device, HOME);
    expect(((await r.json()) as { status: string }).status).toBe("away");

    const aAfter = await scopeA.presence.getCurrent();
    expect(aAfter?.precise).toEqual(aBefore?.precise);
    expect(aAfter?.updatedAt).toBe(aBefore?.updatedAt);
    expect(aAfter?.status).toBe("away");
    const bNow = await scopeB.presence.getCurrent();
    expect(bNow?.precise).toMatchObject(HOME);
    expect(bNow?.updatedAt).not.toBe(aBefore?.updatedAt);

    await ingest(b.device, AWAY);
    expect((await scopeB.presence.getCurrent())?.status).toBe("home");
    expect((await scopeA.presence.getCurrent())?.updatedAt).toBe(aBefore?.updatedAt);
  });

  it("scopes place list, create, and delete to the caller", async () => {
    expect((await req("/v1/places/home", { method: "DELETE", token: b.admin })).status).toBe(404);
    expect((await json("/v1/places", a.admin)).places).toHaveLength(1);

    const created = await send("/v1/places", b.admin, { name: "home", lat: 10, lon: 10, type: "home" });
    expect(created.status).toBe(201);

    const aPlaces = (await json("/v1/places", a.admin)).places;
    const bPlaces = (await json("/v1/places", b.admin)).places;
    expect(aPlaces).toHaveLength(1);
    expect(aPlaces[0]).toMatchObject({ name: "home", lat: HOME.lat, lon: HOME.lon });
    expect(bPlaces).toHaveLength(1);
    expect(bPlaces[0]).toMatchObject({ name: "home", lat: 10, lon: 10 });

    expect((await req("/v1/places/home", { method: "DELETE", token: b.admin })).status).toBe(200);
    expect((await json("/v1/places", a.admin)).places).toHaveLength(1);
  });

  it("does not list A's events to B", async () => {
    await ingest(a.device, HOME);
    expect((await json("/v1/events", a.admin)).events.length).toBeGreaterThan(0);
    expect((await json("/v1/events", b.admin)).events).toEqual([]);
  });

  it("keeps privacy settings and A's presence privacy snapshot per user", async () => {
    await ingest(a.device, AWAY);
    await ingest(b.device, AWAY);
    const aPrivacy = (await scopeA.presence.getCurrent())?.privacy;
    const put = await send(
      "/v1/privacy",
      b.admin,
      { defaultAgentAccess: "hidden", allowPreciseLocation: true },
      "PUT",
    );
    expect(put.status).toBe(200);
    expect((await json("/v1/privacy", b.admin)).settings.defaultAgentAccess).toBe("hidden");
    expect((await json("/v1/privacy", a.admin)).settings.defaultAgentAccess).toBe("coarse");
    expect((await scopeA.presence.getCurrent())?.privacy).toEqual(aPrivacy);
    expect((await scopeB.presence.getCurrent())?.privacy).toEqual({
      mode: "hidden",
      allowPreciseToAgents: true,
    });
    expect((await req("/v1/presence", { token: a.agent })).status).toBe(200);
    // B's mode change emits privacy_changed into B's feed, not A's.
    const aTypes = (await json("/v1/events", a.admin)).events.map((e: any) => e.type);
    expect(aTypes).not.toContain("presence.privacy_changed");
  });

  it("lists and prunes raw history per user", async () => {
    await send("/v1/privacy", a.admin, { storeRawHistory: true }, "PUT");
    await send("/v1/privacy", b.admin, { storeRawHistory: true, retentionHours: 0 }, "PUT");
    await ingest(a.device, AWAY);
    await tick();
    // B's zero-hour retention prunes on B's ingest; A's older point must survive.
    await ingest(b.device, HOME);

    const aPoints = (await json("/v1/presence/history", a.admin)).points;
    expect(aPoints).toHaveLength(1);
    expect(aPoints[0]).toMatchObject(AWAY);
    const bPoints = (await json("/v1/presence/history", b.admin)).points;
    expect(bPoints.some((p: any) => p.lat === AWAY.lat)).toBe(false);
  });

  it("scopes webhook list, delete, and dead letters to the owner", async () => {
    const created = await send("/v1/webhooks", a.admin, { url: "http://127.0.0.1:9/a" });
    expect(created.status).toBe(201);
    const hookId = ((await created.json()) as { webhook: { id: string } }).webhook.id;
    await ctx.system.webhooks.recordDeadLetter(
      hookId,
      { id: "e1", type: "presence.updated", createdAt: new Date().toISOString() },
      "status 500",
    );

    expect((await json("/v1/webhooks", b.admin)).webhooks).toEqual([]);
    expect((await json("/v1/webhooks/dead-letters", b.admin)).deadLetters).toEqual([]);
    expect((await req(`/v1/webhooks/${hookId}`, { method: "DELETE", token: b.admin })).status).toBe(404);

    expect((await json("/v1/webhooks", a.admin)).webhooks.map((h: any) => h.id)).toEqual([hookId]);
    expect((await json("/v1/webhooks/dead-letters", a.admin)).deadLetters).toHaveLength(1);

    expect((await req(`/v1/webhooks/${hookId}`, { method: "DELETE", token: a.admin })).status).toBe(200);
    const orphans = await ctx.handle.client.execute("SELECT count(*) AS c FROM webhook_deliveries");
    expect(orphans.rows[0]!.c).toBe(0);
  });

  it("scopes token list and revoke to the owner", async () => {
    const aIds: string[] = (await json("/v1/tokens", a.admin)).tokens.map((t: any) => t.id);
    const bIds: string[] = (await json("/v1/tokens", b.admin)).tokens.map((t: any) => t.id);
    expect(aIds).toHaveLength(3);
    expect(bIds).toHaveLength(3);
    expect(bIds.some((id) => aIds.includes(id))).toBe(false);

    for (const id of aIds) {
      expect((await req(`/v1/tokens/${id}`, { method: "DELETE", token: b.admin })).status).toBe(404);
    }
    expect((await req("/v1/tokens", { token: a.admin })).status).toBe(200);
  });

  it("caps tokens and webhooks per user", async () => {
    const start = await scopeB.tokens.count();
    const minted = await Promise.all(
      Array.from({ length: 55 - start }, (_, i) => scopeB.tokens.create(`t${i}`, "agent")),
    );
    expect(minted.filter((m) => m === "limit")).toHaveLength(5);
    expect(await scopeB.tokens.count()).toBe(50);
    const overToken = await send("/v1/tokens", b.admin, { name: "one-more", role: "agent" });
    expect(overToken.status).toBe(409);
    expect(await overToken.json()).toEqual({ error: "token limit reached (50)" });
    expect((await send("/v1/tokens", a.admin, { name: "fine", role: "agent" })).status).toBe(201);

    for (let i = 0; i < 20; i++) await scopeB.webhooks.create({ url: `http://127.0.0.1:9/${i}`, events: ["*"] });
    const overHook = await send("/v1/webhooks", b.admin, { url: "http://127.0.0.1:9/x" });
    expect(overHook.status).toBe(409);
    expect(await overHook.json()).toEqual({ error: "webhook limit reached (20)" });
    expect((await send("/v1/webhooks", a.admin, { url: "http://127.0.0.1:9/a" })).status).toBe(201);
  });
});

describe("MCP isolation between users", () => {
  async function connectAs(secret: string): Promise<Client> {
    const principal = await resolveTokenPrincipal(ctx, secret);
    expect(principal).not.toBeNull();
    const server = buildMcpServer(ctx.forUser(principal!.userId), principal!, ctx);
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    await client.connect(clientT);
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    return { data: JSON.parse(res.content[0]!.text), isError: res.isError ?? false };
  }

  it("does not expose A's presence, places, or events to B's tools", async () => {
    await ingest(a.device, HOME);
    const bc = await connectAs(b.agent);

    expect((await call(bc, "get_presence")).data.status).toBe("unknown");
    expect((await call(bc, "get_location_age")).data.note).toBe("no presence recorded yet");
    expect((await call(bc, "list_places")).data.places).toEqual([]);
    expect((await call(bc, "is_near_place", { name: "home" })).isError).toBe(true);
    expect((await call(bc, "list_recent_presence_events")).data.events).toEqual([]);
  });

  it("does not hand A's precise location to B's get_precise_location", async () => {
    await send("/v1/privacy", a.admin, { allowPreciseLocation: true, defaultAgentAccess: "precise" }, "PUT");
    await ingest(a.device, AWAY);
    const ac = await connectAs(a.agent);
    expect((await call(ac, "get_precise_location", { reason: "map" })).data).toMatchObject(AWAY);

    await send("/v1/privacy", b.admin, { allowPreciseLocation: true, defaultAgentAccess: "precise" }, "PUT");
    const bc = await connectAs(b.agent);
    const denied = await call(bc, "get_precise_location", { reason: "map" });
    expect(denied).toEqual({ isError: true, data: { error: "no presence recorded yet" } });
  });

  it("applies each user's own home-place protection", async () => {
    // A turns protection off; B's stays on, so B's agent still cannot write home.
    await send("/v1/privacy", a.admin, { protectHomePlace: false }, "PUT");
    const bc = await connectAs(b.agent);
    expect((await call(bc, "create_place", { name: "home", type: "home", lat: 1, lon: 1 })).isError).toBe(true);
    const ac = await connectAs(a.agent);
    expect((await call(ac, "create_place", { name: "home2", type: "home", lat: 1, lon: 1 })).isError).toBe(false);

    // And the reverse: B turning protection off does not open A's home.
    await send("/v1/privacy", a.admin, { protectHomePlace: true }, "PUT");
    await send("/v1/privacy", b.admin, { protectHomePlace: false }, "PUT");
    expect((await call(await connectAs(a.agent), "create_place", { name: "home", type: "custom", lat: 2, lon: 2 })).isError).toBe(true);
    expect((await call(await connectAs(b.agent), "create_place", { name: "home", type: "home", lat: 1, lon: 1 })).isError).toBe(false);
    expect((await scopeA.places.get("home"))).toMatchObject({ lat: HOME.lat, lon: HOME.lon });
  });

  it("keeps B's place writes and reminders out of A's data", async () => {
    await ingest(a.device, AWAY);
    const bc = await connectAs(b.agent);

    // B has no location, so remembering "here" must not borrow A's.
    expect((await call(bc, "remember_current_place", { name: "spot" })).isError).toBe(true);
    // A's place is not visible to B as a reminder target.
    expect((await call(bc, "create_location_reminder", { place: "home", message: "x" })).isError).toBe(true);

    const created = await call(bc, "create_place", { name: "gym", type: "custom", lat: 1, lon: 1 });
    expect(created.isError).toBe(false);
    const reminder = await call(bc, "create_location_reminder", { place: "gym", message: "stretch" });
    expect(reminder.isError).toBe(false);

    expect((await scopeA.places.list()).map((p) => p.name)).toEqual(["home"]);
    expect(await scopeA.reminders.listActive()).toEqual([]);
    expect((await scopeB.reminders.listActive()).map((r) => r.message)).toEqual(["stretch"]);
  });

  it("fires a reminder only for its owner's place entry", async () => {
    const ac = await connectAs(a.agent);
    expect((await call(ac, "create_location_reminder", { place: "home", message: "A only" })).isError).toBe(false);
    // B registers its own "home" at the same spot and walks into it.
    await send("/v1/places", b.admin, { name: "home", ...HOME, type: "home" });
    const entered = await scopeB.presence.processReading({
      precise: { ...HOME, accuracyM: 10 },
      source: "manual",
      updatedAt: new Date().toISOString(),
    });
    expect(entered.presence.status).toBe("home");
    expect(entered.triggeredReminders).toEqual([]);
    expect((await scopeA.reminders.listActive()).map((r) => r.message)).toEqual(["A only"]);
  });
});

describe("webhook dispatch isolation", () => {
  function dispatcher(fetchFn: (url: string, init: RequestInit) => Promise<Response>, maxAttempts = 5) {
    return new WebhookDispatcher({
      webhooksStore: ctx.system.webhooks,
      eventsStore: ctx.system.events,
      clock: ctx.clock,
      fetchFn: fetchFn as unknown as typeof fetch,
      allowPrivateTargets: true,
      maxAttempts,
    });
  }

  async function eventIds(token: string): Promise<string[]> {
    return (await json("/v1/events", token)).events.map((e: any) => e.id).sort();
  }

  beforeEach(async () => {
    await scopeA.webhooks.create({ url: "http://127.0.0.1:9/a", events: ["*"] });
    await scopeB.webhooks.create({ url: "http://127.0.0.1:9/b", events: ["*"] });
    // Hooks start at "now"; let events land strictly after the cursors.
    await tick();
    await ingest(a.device, HOME);
    await ingest(b.device, AWAY);
  });

  it("delivers each user's events to that user's hook only, in both directions", async () => {
    const delivered: Record<string, string[]> = {};
    await dispatcher(async (url, init) => {
      (delivered[url] ??= []).push(JSON.parse(init.body as string).id);
      return new Response(null, { status: 200 });
    }).tick();

    expect(delivered["http://127.0.0.1:9/a"]!.sort()).toEqual(await eventIds(a.admin));
    expect(delivered["http://127.0.0.1:9/b"]!.sort()).toEqual(await eventIds(b.admin));
  });

  it("dead-letters each user's failures under that user only", async () => {
    await dispatcher(async () => new Response(null, { status: 500 }), 1).tick();

    const aDead = (await json("/v1/webhooks/dead-letters", a.admin)).deadLetters;
    const bDead = (await json("/v1/webhooks/dead-letters", b.admin)).deadLetters;
    expect(aDead.map((d: any) => d.eventId).sort()).toEqual(await eventIds(a.admin));
    expect(bDead.map((d: any) => d.eventId).sort()).toEqual(await eventIds(b.admin));
  });
});
