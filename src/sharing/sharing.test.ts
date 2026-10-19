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
  inviteToken,
  reauth,
  setupOwner,
  signUpByInvite,
  type Enrolled,
} from "../testing/accounts.js";
import { PRECISE_VIEW_AUDIT_INTERVAL_MS } from "./sharesStore.js";

const HOME = { lat: 37.5, lon: 127.0 };
const AWAY = { lat: 37.6, lon: 127.1 };
const CLINIC = { lat: 37.55, lon: 126.95 };
const MINUTE = 60_000;
/** Words from the owner's place names and labels that no viewer may ever see. */
const PLACE_WORDS = ["Oak", "Kim", "Oncology", "clinic"];

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

const ingest = (who: Browser, at: { lat: number; lon: number }) =>
  who.json("/v1/ingest", { body: { source: "manual", ...at } });

async function people(viewer: Member | Enrolled): Promise<any[]> {
  return (await viewer.browser.json("/v1/people")).people;
}

async function person(viewer: Member | Enrolled, ownerId: string): Promise<Response> {
  return viewer.browser.send(`/v1/people/${ownerId}`);
}

async function personOf(viewer: Member | Enrolled, ownerId: string): Promise<any> {
  return (await viewer.browser.json(`/v1/people/${ownerId}`)).person;
}

async function auditOf(who: Member | Enrolled): Promise<any[]> {
  return (await who.browser.json("/v1/shares/audit?limit=500")).audit;
}

async function preciseViews(viewerId: string): Promise<number> {
  return (await auditOf(owner)).filter((a) => a.action === "precise_viewed" && a.viewer.id === viewerId)
    .length;
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

  await owner.browser.json("/v1/places", {
    body: { name: "home", label: "12 Oak St", type: "home", ...HOME, radiusM: 150 },
  });
  await owner.browser.json("/v1/places", {
    body: { name: "Dr. Kim Oncology", label: "Kim clinic, 3rd floor", type: "custom", ...CLINIC, radiusM: 100 },
  });
  await ingest(owner.browser, AWAY);
});

afterEach(() => ctx.handle.client.close());

describe("granting a share", () => {
  it("answers 404 for someone outside my workspaces, without writing anything", async () => {
    const res = await share(mina.browser, outsider.userId, { level: "precise" });
    expect(res.status).toBe(404);
    expect((await share(mina.browser, "no-such-user", { level: "coarse" })).status).toBe(404);
    expect(await shareRows()).toBe(0);
    expect(await people(outsider)).toEqual([]);
    expect(await auditOf(mina)).toEqual([]);
  });

  it("refuses sharing with myself", async () => {
    expect((await share(owner.browser, owner.userId, { level: "coarse" })).status).toBe(400);
    const me = asUserId(owner.userId);
    const options = { mayWiden: true, defaultHideHomeExact: true, defaultShowArea: false };
    expect(await ctx.system.shares.put(me, me, { level: "coarse" }, options)).toBe("not_found");
    expect(await shareRows()).toBe(0);
  });

  it("is listed for both people, with the terms the viewer is held to", async () => {
    const res = await share(owner.browser, mina.userId, { level: "coarse" });
    expect(res.status).toBe(200);
    const shared = { viewer: { id: mina.userId, displayName: "Mina" }, level: "coarse", hideHomeExact: true, showArea: false };
    expect(((await res.json()) as any).share).toEqual(shared);
    expect(await owner.browser.json("/v1/shares")).toEqual({ outgoing: [shared], incoming: [] });
    expect(await mina.browser.json("/v1/shares")).toEqual({
      outgoing: [],
      incoming: [{ owner: { id: owner.userId, displayName: "owner" }, level: "coarse", hideHomeExact: true, showArea: false }],
    });
  });

  it("defaults hideHomeExact to the owner's hideHomeExactCoordinates; an explicit value wins", async () => {
    await owner.browser.json("/v1/privacy", { method: "PUT", body: { hideHomeExactCoordinates: false } });
    let res = await share(owner.browser, mina.userId, { level: "precise" });
    expect(((await res.json()) as any).share.hideHomeExact).toBe(false);

    await owner.browser.json("/v1/privacy", { method: "PUT", body: { hideHomeExactCoordinates: true } });
    res = await share(owner.browser, outsider.userId, { level: "precise" });
    expect(((await res.json()) as any).share.hideHomeExact).toBe(true);

    await owner.browser.send(`/v1/shares/${outsider.userId}`, { method: "DELETE" });
    res = await share(owner.browser, outsider.userId, { level: "precise", hideHomeExact: false });
    expect(((await res.json()) as any).share.hideHomeExact).toBe(false);
  });

  it("keeps hideHomeExact when an update omits it", async () => {
    await share(owner.browser, mina.userId, { level: "coarse", hideHomeExact: true });
    const res = await share(owner.browser, mina.userId, { level: "precise" });
    expect(((await res.json()) as any).share).toMatchObject({ level: "precise", hideHomeExact: true });
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
  it("is never cached: the list and the person read send Cache-Control: no-store", async () => {
    await share(owner.browser, mina.userId, { level: "precise", hideHomeExact: false });
    for (const path of ["/v1/people", `/v1/people/${owner.userId}`]) {
      const res = await mina.browser.send(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control"), path).toBe("no-store");
    }
  });

  it("shows a coarse share's status name and minute-bucketed age, never coordinates", async () => {
    await share(owner.browser, mina.userId, { level: "coarse" });
    clock.advance(119_000);
    const body = await mina.browser.json("/v1/people");
    expect(body.people).toEqual([
      {
        user: { id: owner.userId, displayName: "owner" },
        level: "coarse",
        paused: false,
        presence: { status: "away", label: "away", motion: "unknown", updatedAgoMin: 1, stale: false, freshness: "live" },
        precise: null,
      },
    ]);
    const detail = await personOf(mina, owner.userId);
    expect(detail).toEqual({ ...body.people[0], precise: null });
    const text = JSON.stringify([body, detail]);
    expect(text).not.toContain(String(AWAY.lat));
    expect(text).not.toMatch(/"lat"|"lon"|geohash|Sec"/);
  });

  it("lists a precise share as available and gives coordinates only on the person read", async () => {
    await share(owner.browser, mina.userId, { level: "precise", hideHomeExact: false });
    const [listed] = await people(mina);
    expect(listed.precise).toBe("available");
    expect(JSON.stringify(listed)).not.toContain(String(AWAY.lat));
    const detail = await personOf(mina, owner.userId);
    expect(detail.precise).toEqual({
      lat: AWAY.lat,
      lon: AWAY.lon,
      mapUrl: `https://maps.google.com/?q=${AWAY.lat},${AWAY.lon}`,
      updatedAgoMin: 0,
    });
  });

  it("never carries the owner's place names or labels", async () => {
    const reads: string[] = [];
    const readAll = async () => {
      reads.push(JSON.stringify(await mina.browser.json("/v1/people")));
      reads.push(JSON.stringify(await mina.browser.json(`/v1/people/${owner.userId}`)));
    };
    for (const terms of [
      { level: "coarse" },
      { level: "precise", hideHomeExact: true },
      { level: "precise", hideHomeExact: false },
    ]) {
      await share(owner.browser, mina.userId, terms);
      await ingest(owner.browser, HOME);
      await readAll();
      await ingest(owner.browser, CLINIC);
      await readAll();
    }
    const seen = reads.join("\n");
    expect(seen).toContain('"status":"home"');
    expect(seen).toContain('"status":"custom"');
    for (const word of PLACE_WORDS) expect(seen).not.toContain(word);
  });

  it("withholds coordinates at home when hideHomeExact is on, and says why", async () => {
    await ingest(owner.browser, HOME);
    await share(owner.browser, mina.userId, { level: "precise", hideHomeExact: true });
    let detail = await personOf(mina, owner.userId);
    expect(detail).toMatchObject({ presence: { status: "home" }, precise: null, preciseWithheld: "at_home" });
    expect((await people(mina))[0]).toMatchObject({ precise: null, preciseWithheld: "at_home" });

    await ingest(owner.browser, AWAY);
    detail = await personOf(mina, owner.userId);
    expect(detail.precise).toMatchObject(AWAY);
    expect(detail.preciseWithheld).toBeUndefined();

    await share(owner.browser, mina.userId, { level: "precise", hideHomeExact: false });
    await ingest(owner.browser, HOME);
    expect((await personOf(mina, owner.userId)).precise).toMatchObject(HOME);
  });

  it("fails closed when hideHomeExact is on but the owner has no home place", async () => {
    // Mina has no places, so the server cannot tell when she is home.
    await ingest(mina.browser, AWAY);
    await share(mina.browser, owner.userId, { level: "precise" });
    const detail = await personOf(owner, mina.userId);
    expect(detail).toMatchObject({ presence: { status: "unknown" }, precise: null, preciseWithheld: "no_home_place" });
    expect(await auditOf(mina)).not.toContainEqual(expect.objectContaining({ action: "precise_viewed" }));

    await share(mina.browser, owner.userId, { level: "precise", hideHomeExact: false });
    expect((await personOf(owner, mina.userId)).precise).toMatchObject(AWAY);
  });

  it("hides a paused owner from every viewer, without touching the shares", async () => {
    await share(owner.browser, mina.userId, { level: "precise", hideHomeExact: false });
    await share(owner.browser, outsider.userId, { level: "coarse" });
    await owner.browser.json("/v1/privacy", { method: "PUT", body: { sharingPaused: true } });

    const paused = { user: { id: owner.userId, displayName: "owner" }, paused: true, presence: null, precise: null };
    expect(await people(mina)).toEqual([{ ...paused, level: "precise" }]);
    expect(await personOf(mina, owner.userId)).toEqual({ ...paused, level: "precise" });
    expect(await people(outsider)).toEqual([{ ...paused, level: "coarse" }]);
    expect(await preciseViews(mina.userId)).toBe(0);
    expect((await owner.browser.json("/v1/shares")).outgoing).toHaveLength(2);

    await owner.browser.json("/v1/privacy", { method: "PUT", body: { sharingPaused: false } });
    expect((await personOf(mina, owner.userId)).precise).toMatchObject(AWAY);
  });

  it("does not follow the owner's agent policy", async () => {
    await share(owner.browser, mina.userId, { level: "precise", hideHomeExact: false });
    await owner.browser.json("/v1/privacy", {
      method: "PUT",
      body: { defaultAgentAccess: "hidden", allowPreciseLocation: false },
    });
    const { secret } = await owner.browser.json("/v1/tokens", { body: { name: "claude", role: "agent" } });
    const agentView = await app.request("/v1/presence", { headers: { authorization: `Bearer ${secret}` } });
    expect(agentView.status).toBe(403);
    expect(((await agentView.json()) as any).privacy).toBe("hidden");

    const detail = await personOf(mina, owner.userId);
    expect(detail).toMatchObject({ paused: false, presence: { status: "away" }, precise: AWAY });
  });

  it("ends at once when revoked", async () => {
    await share(owner.browser, mina.userId, { level: "precise" });
    expect(await people(mina)).toHaveLength(1);
    expect((await owner.browser.send(`/v1/shares/${mina.userId}`, { method: "DELETE" })).status).toBe(200);
    expect(await people(mina)).toEqual([]);
    expect((await person(mina, owner.userId)).status).toBe(404);
    expect((await owner.browser.send(`/v1/shares/${mina.userId}`, { method: "DELETE" })).status).toBe(404);
  });

  it("answers 404 for a person who does not share with me", async () => {
    expect((await person(mina, owner.userId)).status).toBe(404);
    expect((await person(mina, outsider.userId)).status).toBe(404);
    expect((await person(mina, "no-such-user")).status).toBe(404);
  });

  it("leaves the owner's own data untouched", async () => {
    await share(owner.browser, mina.userId, { level: "precise" });
    const ownerScope = ctx.forUser(asUserId(owner.userId));
    const before = { presence: await ownerScope.presence.getCurrent(), places: await ownerScope.places.list() };
    await people(mina);
    await personOf(mina, owner.userId);
    expect((await mina.browser.send(`/v1/shares/${owner.userId}`, { method: "DELETE" })).status).toBe(404);
    await ingest(mina.browser, HOME);
    expect({ presence: await ownerScope.presence.getCurrent(), places: await ownerScope.places.list() }).toEqual(before);
    expect((await owner.browser.json("/v1/shares")).outgoing).toHaveLength(1);
  });
});

describe("a viewer declining", () => {
  it("ends the share and tells the owner why", async () => {
    await share(owner.browser, mina.userId, { level: "precise", hideHomeExact: false });
    clock.advance(1000);
    const decline = () => mina.browser.send(`/v1/shares/incoming/${owner.userId}`, { method: "DELETE" });
    expect((await decline()).status).toBe(200);
    expect(await people(mina)).toEqual([]);
    expect((await owner.browser.json("/v1/shares")).outgoing).toEqual([]);
    expect((await auditOf(owner))[0]).toMatchObject({
      action: "revoked",
      reason: "viewer_declined",
      viewer: { id: mina.userId, displayName: "Mina" },
      before: { level: "precise", hideHomeExact: false },
      after: null,
    });
    expect((await decline()).status).toBe(404);
    expect((await outsider.browser.send(`/v1/shares/incoming/${mina.userId}`, { method: "DELETE" })).status).toBe(404);
  });
});

describe("when a membership ends", () => {
  async function secondWorkspaceWithMina(): Promise<string> {
    const team = (await owner.browser.json("/v1/workspaces", { body: { name: "Team" } })).workspace.id;
    const { url } = await owner.browser.json(`/v1/workspaces/${team}/invites`, { body: { role: "member" } });
    await mina.browser.json("/v1/workspaces/invites/accept", { body: { token: inviteToken(url) } });
    return team;
  }

  const leave = (who: Member, ws: string) =>
    who.browser.json(`/v1/workspaces/${ws}/members/${who.userId}`, { method: "DELETE" });

  const ended = (viewerId: string) =>
    expect.objectContaining({ action: "revoked", reason: "membership_ended", viewer: expect.objectContaining({ id: viewerId }) });

  it("keeps the share while another workspace is common, and ends it with the last", async () => {
    const team = await secondWorkspaceWithMina();
    await share(owner.browser, mina.userId, { level: "precise" });
    await share(mina.browser, owner.userId, { level: "coarse" });

    await leave(mina, team);
    expect(await shareRows()).toBe(2);
    expect(await people(mina)).toHaveLength(1);
    expect(await people(owner)).toHaveLength(1);
    expect(await auditOf(owner)).not.toContainEqual(ended(mina.userId));

    await leave(mina, defaultWs);
    expect(await shareRows()).toBe(0);
    expect(await people(mina)).toEqual([]);
    expect(await people(owner)).toEqual([]);
    expect((await auditOf(owner))[0]).toEqual(ended(mina.userId));
    expect((await auditOf(owner))[0].before).toEqual({ level: "precise", hideHomeExact: true, showArea: false });
    expect((await auditOf(mina))[0]).toEqual(ended(owner.userId));
  });

  it("ends the share when an admin removes the member", async () => {
    await share(owner.browser, mina.userId, { level: "coarse" });
    await owner.browser.json(`/v1/workspaces/${defaultWs}/members/${mina.userId}`, { method: "DELETE" });
    expect(await shareRows()).toBe(0);
    expect((await auditOf(owner))[0]).toEqual(ended(mina.userId));
  });

  it("ends the share whatever deletes the membership", async () => {
    await share(owner.browser, mina.userId, { level: "precise" });
    await ctx.handle.client.execute({ sql: "DELETE FROM memberships WHERE user_id = ?", args: [mina.userId] });
    expect(await shareRows()).toBe(0);
    expect(await people(mina)).toEqual([]);
    expect((await auditOf(owner))[0]).toEqual(ended(mina.userId));
  });

  it("keeps the shares of people who still have a workspace in common", async () => {
    await share(owner.browser, outsider.userId, { level: "coarse" });
    await share(owner.browser, mina.userId, { level: "coarse" });
    await owner.browser.json(`/v1/workspaces/${defaultWs}/members/${mina.userId}`, { method: "DELETE" });
    expect(await people(outsider)).toHaveLength(1);
    expect(await shareRows()).toBe(1);
  });
});

describe("agents", () => {
  async function connectAs(secret: string): Promise<Client> {
    const principal = (await resolveTokenPrincipal(ctx, secret))!;
    const server = buildMcpServer(ctx.forUser(principal.userId), principal, ctx);
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    await client.connect(clientT);
    return client;
  }

  async function everyToolOutput(client: Client): Promise<string[]> {
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
    return outputs;
  }

  it("of the viewer see nothing of a person who shares with their owner, over REST or MCP", async () => {
    await share(owner.browser, mina.userId, { level: "precise" });
    const { secret } = await mina.browser.json("/v1/tokens", { body: { name: "claude", role: "agent" } });
    const bearer = { authorization: `Bearer ${secret}` };

    expect((await app.request("/v1/people", { headers: bearer })).status).toBe(403);
    expect((await app.request(`/v1/people/${owner.userId}`, { headers: bearer })).status).toBe(403);
    expect((await app.request("/v1/shares", { headers: bearer })).status).toBe(403);
    expect((await app.request("/v1/presence", { headers: bearer })).status).toBe(404);

    const outputs = await everyToolOutput(await connectAs(secret));
    const seen = outputs.join("\n");
    expect(outputs.length).toBeGreaterThanOrEqual(5);
    expect(seen).not.toContain(String(AWAY.lat));
    expect(seen).not.toContain('"away"');
    expect(seen).not.toContain("share");
  });

  it("of the owner, their events and their webhooks see no share data", async () => {
    const delivered: any[] = [];
    await ctx.forUser(asUserId(owner.userId)).webhooks.create({ url: "http://127.0.0.1:9/hook", events: ["*"] });
    clock.advance(1000);
    await share(owner.browser, mina.userId, { level: "precise", hideHomeExact: false });
    await personOf(mina, owner.userId);
    await share(owner.browser, mina.userId, { level: "coarse" });
    await owner.browser.send(`/v1/shares/${mina.userId}`, { method: "DELETE" });
    expect(await auditOf(owner)).toHaveLength(4);

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
    expect(delivered).toEqual([]);

    const { secret } = await owner.browser.json("/v1/tokens", { body: { name: "claude", role: "agent" } });
    const events = await owner.browser.json("/v1/events?limit=500");
    const agentEvents = await app.request("/v1/events", { headers: { authorization: `Bearer ${secret}` } });
    const mcp = await everyToolOutput(await connectAs(secret));
    const seen = [JSON.stringify(events), await agentEvents.text(), ...mcp].join("\n");
    expect(seen).not.toContain("share");
    expect(seen).not.toContain(mina.userId);

    const hook = await owner.browser.send("/v1/webhooks", {
      body: { url: "https://hooks.example.com/x", events: ["share.granted"] },
    });
    expect(hook.status).toBe(400);
  });
});

describe("the share audit", () => {
  it("records grants, changes and revokes with what changed, newest first", async () => {
    await share(owner.browser, mina.userId, { level: "coarse" });
    clock.advance(1000);
    await share(owner.browser, mina.userId, { level: "coarse" });
    clock.advance(1000);
    await share(owner.browser, mina.userId, { level: "precise" });
    clock.advance(1000);
    await share(owner.browser, mina.userId, { level: "precise", hideHomeExact: false });
    clock.advance(1000);
    await owner.browser.send(`/v1/shares/${mina.userId}`, { method: "DELETE" });

    const audit = await auditOf(owner);
    expect(audit.map(({ action, reason, before, after }) => ({ action, reason, before, after }))).toEqual([
      { action: "revoked", reason: null, before: { level: "precise", hideHomeExact: false, showArea: false }, after: null },
      {
        action: "changed",
        reason: null,
        before: { level: "precise", hideHomeExact: true, showArea: false },
        after: { level: "precise", hideHomeExact: false, showArea: false },
      },
      {
        action: "changed",
        reason: null,
        before: { level: "coarse", hideHomeExact: true, showArea: false },
        after: { level: "precise", hideHomeExact: true, showArea: false },
      },
      { action: "granted", reason: null, before: null, after: { level: "coarse", hideHomeExact: true, showArea: false } },
    ]);
    expect(audit.every((a) => a.viewer.id === mina.userId && a.viewer.displayName === "Mina")).toBe(true);
    expect(await auditOf(mina)).toEqual([]);
    expect((await owner.browser.json("/v1/shares/audit?limit=2")).audit).toHaveLength(2);
  });

  it("is session-only", async () => {
    const { secret } = await owner.browser.json("/v1/tokens", { body: { name: "admin", role: "admin" } });
    const res = await app.request("/v1/shares/audit", { headers: { authorization: `Bearer ${secret}` } });
    expect(res.status).toBe(403);
  });

  it("records a precise view at most once an hour per viewer, from exactly 60 minutes", async () => {
    await share(owner.browser, mina.userId, { level: "precise", hideHomeExact: false });
    await share(owner.browser, outsider.userId, { level: "precise", hideHomeExact: false });

    await personOf(mina, owner.userId);
    await personOf(mina, owner.userId);
    expect(await preciseViews(mina.userId)).toBe(1);
    await personOf(outsider, owner.userId);
    expect(await preciseViews(outsider.userId)).toBe(1);

    clock.advance(PRECISE_VIEW_AUDIT_INTERVAL_MS - 1);
    await personOf(mina, owner.userId);
    expect(await preciseViews(mina.userId)).toBe(1);
    clock.advance(1);
    await personOf(mina, owner.userId);
    expect(await preciseViews(mina.userId)).toBe(2);
    expect(await preciseViews(outsider.userId)).toBe(1);
  });

  it("records nothing for list reads, coarse reads, withheld coordinates or a revoked viewer", async () => {
    await share(owner.browser, mina.userId, { level: "precise", hideHomeExact: false });
    await people(mina);
    await people(mina);

    await share(owner.browser, outsider.userId, { level: "coarse" });
    await personOf(outsider, owner.userId);

    await share(owner.browser, mina.userId, { level: "precise", hideHomeExact: true });
    await ingest(owner.browser, HOME);
    expect((await personOf(mina, owner.userId)).precise).toBeNull();

    await share(owner.browser, mina.userId, { level: "precise", hideHomeExact: false });
    await owner.browser.send(`/v1/shares/${mina.userId}`, { method: "DELETE" });
    expect((await person(mina, owner.userId)).status).toBe(404);

    expect((await auditOf(owner)).filter((a) => a.action === "precise_viewed")).toEqual([]);
  });

  it("is pruned after its retention", async () => {
    await share(owner.browser, mina.userId, { level: "coarse" });
    clock.advance(24 * 3600_000);
    await reauth(owner.browser, owner.credentialId);
    expect((await share(owner.browser, mina.userId, { level: "precise" })).status).toBe(200);
    expect(await ctx.system.shares.pruneAudit(1)).toBe(0);
    clock.advance(MINUTE);
    expect(await ctx.system.shares.pruneAudit(1)).toBe(1);
    expect((await auditOf(owner)).map((a) => a.action)).toEqual(["changed"]);
  });
});

describe("showing my neighbourhood", () => {
  const setArea = (area: string | null) =>
    ctx.handle.client.execute({ sql: "UPDATE presence SET area = ? WHERE user_id = ?", args: [area, owner.userId] });

  it("is off for a new share unless areaToPeople says otherwise; an explicit value wins", async () => {
    let res = await share(owner.browser, mina.userId, { level: "coarse" });
    expect(((await res.json()) as any).share.showArea).toBe(false);
    await owner.browser.json("/v1/privacy", { method: "PUT", body: { areaToPeople: true } });
    res = await share(owner.browser, outsider.userId, { level: "coarse" });
    expect(((await res.json()) as any).share.showArea).toBe(true);
    await owner.browser.send(`/v1/shares/${outsider.userId}`, { method: "DELETE" });
    res = await share(owner.browser, outsider.userId, { level: "coarse", showArea: false });
    expect(((await res.json()) as any).share.showArea).toBe(false);
  });

  it("needs a fresh passkey to turn on, not to turn off, and is audited", async () => {
    await share(owner.browser, mina.userId, { level: "coarse" });
    clock.advance(11 * MINUTE);
    const on = await share(owner.browser, mina.userId, { level: "coarse", showArea: true });
    expect(on.status).toBe(403);
    expect(((await on.json()) as any).code).toBe("reauth_required");
    await reauth(owner.browser, owner.credentialId);
    expect((await share(owner.browser, mina.userId, { level: "coarse", showArea: true })).status).toBe(200);
    clock.advance(11 * MINUTE);
    expect((await share(owner.browser, mina.userId, { level: "coarse", showArea: false })).status).toBe(200);
    const changes = (await auditOf(owner)).filter((a) => a.action === "changed");
    expect(changes.map((a) => [a.before.showArea, a.after.showArea])).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  it("shows the area only with showArea on and the owner's maps switch on", async () => {
    await setArea("테스트구 테스트1동");
    await share(owner.browser, mina.userId, { level: "coarse" });
    expect((await personOf(mina, owner.userId)).presence.area).toBeUndefined();
    await share(owner.browser, mina.userId, { level: "coarse", showArea: true });
    expect((await personOf(mina, owner.userId)).presence.area).toBeUndefined();
    await owner.browser.json("/v1/privacy", { method: "PUT", body: { geoEnabled: true } });
    // With no maps key the lookup that turning maps on starts drops the area; set it after.
    await ctx.system.geo.settled();
    await setArea("테스트구 테스트1동");
    expect((await personOf(mina, owner.userId)).presence.area).toBe("테스트구 테스트1동");
    expect((await people(mina))[0].presence.area).toBe("테스트구 테스트1동");
    await share(owner.browser, mina.userId, { level: "coarse", showArea: false });
    expect(JSON.stringify(await personOf(mina, owner.userId))).not.toContain("테스트");
  });

  it("is copied into the audit when a membership ends the share", async () => {
    await share(owner.browser, mina.userId, { level: "coarse", showArea: true });
    await mina.browser.json(`/v1/workspaces/${defaultWs}/members/${mina.userId}`, { method: "DELETE" });
    expect((await auditOf(owner))[0]).toMatchObject({
      reason: "membership_ended",
      before: { level: "coarse", hideHomeExact: true, showArea: true },
    });
  });
});
