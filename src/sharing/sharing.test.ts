import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AppContext } from "../app/context.js";
import { resolveTokenPrincipal } from "../auth/principal.js";
import { buildMcpServer } from "../mcp/server.js";
import { asUserId } from "../types.js";
import { WebhookDispatcher } from "../webhooks/dispatcher.js";
import {
  Browser,
  TestClock,
  bootApp,
  setupOwner,
  signUpByInvite,
  type Enrolled,
} from "../testing/accounts.js";

const HOME = { lat: 37.5, lon: 127.0 };
const AWAY = { lat: 37.6, lon: 127.1 };
const MINUTE = 60_000;

interface Member {
  browser: Browser;
  userId: string;
  credentialId: string;
}

let clock: TestClock;
let ctx: AppContext;
let app: Hono;
let owner: Enrolled;
let mina: Member;
let outsider: Member;
let defaultWs: string;

async function join(browser: Browser, workspaceId: string, name: string): Promise<Member> {
  const { url } = await browser.json(`/v1/workspaces/${workspaceId}/invites`, { body: { role: "member" } });
  const { browser: joined, res, credentialId } = await signUpByInvite(app, url, name);
  expect(res.status).toBe(201);
  return { browser: joined, userId: ((await res.json()) as any).userId, credentialId };
}

const share = (from: Browser, viewer: string, body: unknown) =>
  from.send(`/v1/shares/${viewer}`, { method: "PUT", body });

async function people(viewer: Member): Promise<any[]> {
  return (await viewer.browser.json("/v1/people")).people;
}

async function ownerEvents(): Promise<any[]> {
  return (await owner.browser.json("/v1/events?limit=500")).events;
}

async function shareRows(): Promise<number> {
  const rows = await ctx.handle.client.execute("SELECT count(*) AS c FROM location_shares");
  return Number(rows.rows[0]!.c);
}

beforeEach(async () => {
  clock = new TestClock();
  const booted = await bootApp(clock);
  ({ ctx, app } = booted);
  owner = await setupOwner(app, booted.setupCode);
  defaultWs = (await owner.browser.json("/v1/workspaces")).workspaces[0].id;
  mina = await join(owner.browser, defaultWs, "Mina");
  // The outsider shares a second workspace with the owner, none with Mina.
  const other = (await owner.browser.json("/v1/workspaces", { body: { name: "Other" } })).workspace.id;
  outsider = await join(owner.browser, other, "Olli");

  await owner.browser.json("/v1/places", { body: { name: "home", type: "home", ...HOME, radiusM: 150 } });
  await owner.browser.json("/v1/ingest", { body: { source: "manual", ...AWAY } });
});

afterEach(() => ctx.handle.client.close());

describe("granting a share", () => {
  it("answers 404 for someone outside my workspaces, without writing anything", async () => {
    const res = await share(mina.browser, outsider.userId, { level: "precise" });
    expect(res.status).toBe(404);
    expect((await share(mina.browser, "no-such-user", { level: "coarse" })).status).toBe(404);
    expect(await shareRows()).toBe(0);
    expect(await people(outsider)).toEqual([]);
  });

  it("refuses sharing with myself", async () => {
    expect((await share(owner.browser, owner.userId, { level: "coarse" })).status).toBe(400);
    const me = asUserId(owner.userId);
    expect(await ctx.system.shares.put(me, me, { level: "coarse" })).toBeNull();
    expect(await shareRows()).toBe(0);
  });

  it("is listed for both people", async () => {
    const res = await share(owner.browser, mina.userId, { level: "coarse" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).share).toEqual({
      viewer: { id: mina.userId, displayName: "Mina" },
      level: "coarse",
      hideHomeExact: false,
    });
    expect(await owner.browser.json("/v1/shares")).toEqual({
      outgoing: [{ viewer: { id: mina.userId, displayName: "Mina" }, level: "coarse", hideHomeExact: false }],
      incoming: [],
    });
    expect(await mina.browser.json("/v1/shares")).toEqual({
      outgoing: [],
      incoming: [{ owner: { id: owner.userId, displayName: "owner" }, level: "coarse" }],
    });
  });

  it("is session-only", async () => {
    const { secret } = await owner.browser.json("/v1/tokens", { body: { name: "admin", role: "admin" } });
    const res = await app.request(`/v1/shares/${mina.userId}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ level: "precise" }),
    });
    expect(res.status).toBe(403);
    expect(await shareRows()).toBe(0);
  });
});

describe("what a viewer sees", () => {
  it("shows a coarse share's status and never coordinates", async () => {
    await share(owner.browser, mina.userId, { level: "coarse" });
    const body = await mina.browser.json("/v1/people");
    expect(body.people).toEqual([
      {
        user: { id: owner.userId, displayName: "owner" },
        level: "coarse",
        presence: { status: "away", label: expect.any(String), motion: "unknown", updatedAgoSec: 0, stale: false },
        precise: null,
      },
    ]);
    const text = JSON.stringify(body);
    expect(text).not.toContain(String(AWAY.lat));
    expect(text).not.toContain(String(AWAY.lon));
    expect(text).not.toMatch(/"lat"|"lon"|geohash/);
  });

  it("shows a precise share's coordinates", async () => {
    await share(owner.browser, mina.userId, { level: "precise" });
    const [person] = await people(mina);
    expect(person.precise).toMatchObject({ lat: AWAY.lat, lon: AWAY.lon, mapUrl: expect.stringContaining("37.6") });
  });

  it("withholds coordinates at home when hideHomeExact is on, and only then", async () => {
    await owner.browser.json("/v1/ingest", { body: { source: "manual", ...HOME } });
    await share(owner.browser, mina.userId, { level: "precise", hideHomeExact: true });
    let [person] = await people(mina);
    expect(person.presence.status).toBe("home");
    expect(person.precise).toBeNull();

    await share(owner.browser, mina.userId, { level: "precise", hideHomeExact: false });
    [person] = await people(mina);
    expect(person.precise).toMatchObject(HOME);

    await share(owner.browser, mina.userId, { level: "precise", hideHomeExact: true });
    await owner.browser.json("/v1/ingest", { body: { source: "manual", ...AWAY } });
    [person] = await people(mina);
    expect(person.precise).toMatchObject(AWAY);
  });

  it("keeps hideHomeExact when an update omits it", async () => {
    await share(owner.browser, mina.userId, { level: "coarse", hideHomeExact: true });
    const res = await share(owner.browser, mina.userId, { level: "precise" });
    expect(((await res.json()) as any).share).toMatchObject({ level: "precise", hideHomeExact: true });
  });

  it("ends at once when revoked", async () => {
    await share(owner.browser, mina.userId, { level: "precise" });
    expect(await people(mina)).toHaveLength(1);
    expect((await owner.browser.send(`/v1/shares/${mina.userId}`, { method: "DELETE" })).status).toBe(200);
    expect(await people(mina)).toEqual([]);
    expect((await owner.browser.send(`/v1/shares/${mina.userId}`, { method: "DELETE" })).status).toBe(404);
  });

  it("ends when the two leave their last common workspace, and the share is deleted", async () => {
    await share(owner.browser, mina.userId, { level: "precise" });
    await share(mina.browser, owner.userId, { level: "coarse" });
    expect(await shareRows()).toBe(2);
    await mina.browser.json(`/v1/workspaces/${defaultWs}/members/${mina.userId}`, { method: "DELETE" });
    expect(await people(mina)).toEqual([]);
    expect(await people(owner)).toEqual([]);
    expect(await shareRows()).toBe(0);
  });

  it("checks the common workspace at read time too", async () => {
    await share(owner.browser, mina.userId, { level: "precise" });
    await ctx.handle.client.execute({
      sql: "DELETE FROM memberships WHERE user_id = ?",
      args: [mina.userId],
    });
    expect(await shareRows()).toBe(1);
    expect(await people(mina)).toEqual([]);
    expect((await owner.browser.json("/v1/shares")).outgoing).toEqual([]);
  });

  it("keeps the shares of people who still have a workspace in common", async () => {
    await share(owner.browser, outsider.userId, { level: "coarse" });
    await share(owner.browser, mina.userId, { level: "coarse" });
    await owner.browser.json(`/v1/workspaces/${defaultWs}/members/${mina.userId}`, { method: "DELETE" });
    expect(await people(outsider)).toHaveLength(1);
    expect(await shareRows()).toBe(1);
  });

  it("leaves the owner's own data untouched", async () => {
    await share(owner.browser, mina.userId, { level: "precise" });
    const ownerScope = ctx.forUser(asUserId(owner.userId));
    const before = { presence: await ownerScope.presence.getCurrent(), places: await ownerScope.places.list() };
    await people(mina);
    expect((await mina.browser.send(`/v1/shares/${owner.userId}`, { method: "DELETE" })).status).toBe(404);
    await mina.browser.json("/v1/ingest", { body: { source: "manual", ...HOME } });
    expect({ presence: await ownerScope.presence.getCurrent(), places: await ownerScope.places.list() }).toEqual(before);
    expect((await owner.browser.json("/v1/shares")).outgoing).toHaveLength(1);
  });
});

describe("agents of the viewer", () => {
  async function connectAs(secret: string): Promise<Client> {
    const principal = (await resolveTokenPrincipal(ctx, secret))!;
    const server = buildMcpServer(ctx.forUser(principal.userId), principal, ctx);
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    await client.connect(clientT);
    return client;
  }

  it("see nothing of a person who shares with their owner, over REST or MCP", async () => {
    await share(owner.browser, mina.userId, { level: "precise" });
    const { secret } = await mina.browser.json("/v1/tokens", { body: { name: "claude", role: "agent" } });
    const bearer = { authorization: `Bearer ${secret}` };

    expect((await app.request("/v1/people", { headers: bearer })).status).toBe(403);
    expect((await app.request("/v1/shares", { headers: bearer })).status).toBe(403);
    expect((await app.request("/v1/presence", { headers: bearer })).status).toBe(404);

    const client = await connectAs(secret);
    const { tools } = await client.listTools();
    const outputs: string[] = [];
    for (const tool of tools) {
      const args: Record<string, unknown> =
        tool.name === "get_precise_location" ? { reason: "test" }
        : tool.name === "is_near_place" ? { name: "home" }
        : {};
      if (["create_location_reminder", "create_place", "remember_current_place"].includes(tool.name)) continue;
      const res = (await client.callTool({ name: tool.name, arguments: args })) as any;
      outputs.push(res.content[0].text);
    }
    const seen = outputs.join("\n");
    expect(outputs.length).toBeGreaterThanOrEqual(5);
    expect(seen).not.toContain(String(AWAY.lat));
    expect(seen).not.toContain('"away"');
    expect(seen).not.toContain("share.");
  });
});

describe("audit", () => {
  it("logs grants, changes and revokes in the owner's events", async () => {
    await share(owner.browser, mina.userId, { level: "coarse" });
    clock.advance(1000);
    await share(owner.browser, mina.userId, { level: "coarse" });
    clock.advance(1000);
    await share(owner.browser, mina.userId, { level: "precise" });
    clock.advance(1000);
    await owner.browser.send(`/v1/shares/${mina.userId}`, { method: "DELETE" });
    const shareEvents = (await ownerEvents()).filter((e) => e.type.startsWith("share."));
    expect(shareEvents.map((e) => [e.type, e.viewerUserId, e.level]).reverse()).toEqual([
      ["share.granted", mina.userId, "coarse"],
      ["share.changed", mina.userId, "precise"],
      ["share.revoked", mina.userId, undefined],
    ]);
    expect((await mina.browser.json("/v1/events")).events.some((e: any) => e.type.startsWith("share."))).toBe(false);
  });

  it("logs precise views at most once an hour per viewer", async () => {
    await share(owner.browser, mina.userId, { level: "precise" });
    const viewed = async () =>
      (await ownerEvents()).filter((e) => e.type === "share.precise_viewed" && e.viewerUserId === mina.userId);

    await people(mina);
    await people(mina);
    expect(await viewed()).toHaveLength(1);
    clock.advance(59 * MINUTE);
    await people(mina);
    expect(await viewed()).toHaveLength(1);
    clock.advance(2 * MINUTE);
    await people(mina);
    expect(await viewed()).toHaveLength(2);
  });

  it("does not log coarse views or home-withheld precise views", async () => {
    await share(owner.browser, mina.userId, { level: "coarse" });
    await people(mina);
    await owner.browser.json("/v1/ingest", { body: { source: "manual", ...HOME } });
    await share(owner.browser, mina.userId, { level: "precise", hideHomeExact: true });
    await people(mina);
    expect((await ownerEvents()).some((e) => e.type === "share.precise_viewed")).toBe(false);
  });

  it("shows the owner's agents that sharing happened, not with whom", async () => {
    await share(owner.browser, mina.userId, { level: "precise" });
    await people(mina);
    const { secret } = await owner.browser.json("/v1/tokens", { body: { name: "claude", role: "agent" } });
    const res = await app.request("/v1/events", { headers: { authorization: `Bearer ${secret}` } });
    const events = ((await res.json()) as any).events.filter((e: any) => e.type.startsWith("share."));
    expect(events.map((e: any) => e.type).sort()).toEqual(["share.granted", "share.precise_viewed"]);
    expect(JSON.stringify(events)).not.toContain(mina.userId);

    const principal = (await resolveTokenPrincipal(ctx, secret))!;
    const server = buildMcpServer(ctx.forUser(principal.userId), principal, ctx);
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    await client.connect(clientT);
    const out = (await client.callTool({ name: "list_recent_presence_events", arguments: { limit: 50 } })) as any;
    const text = out.content[0].text as string;
    expect(text).toContain("share.precise_viewed");
    expect(text).not.toContain(mina.userId);
  });

  it("delivers share events to the owner's webhooks with the viewer", async () => {
    const delivered: any[] = [];
    await ctx.forUser(asUserId(owner.userId)).webhooks.create({ url: "http://127.0.0.1:9/hook", events: ["share.granted"] });
    clock.advance(1000);
    await share(owner.browser, mina.userId, { level: "coarse" });
    const dispatcher = new WebhookDispatcher({
      webhooksStore: ctx.system.webhooks,
      eventsStore: ctx.system.events,
      clock: ctx.clock,
      allowPrivateTargets: true,
      fetchFn: (async (_url: string, init: RequestInit) => {
        delivered.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
    });
    await dispatcher.tick();
    expect(delivered).toEqual([
      expect.objectContaining({ event: "share.granted", viewer: mina.userId, level: "coarse" }),
    ]);
  });
});
