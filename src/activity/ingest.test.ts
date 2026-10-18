import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import type { AppContext } from "../app/context.js";
import { recentLogs } from "../util/log.js";
import { Browser, TestClock, bootApp, setupOwner, signUpByInvite, type Enrolled } from "../testing/accounts.js";

const DAY = 86_400_000;
const LAT = "37.51234";
const LON = "127.04321";

let clock: TestClock;
let ctx: AppContext;
let app: Hono;
let owner: Enrolled;
let mina: Browser;
let phone: { id: string; secret: string };

async function mint(browser: Browser, name: string, role = "device"): Promise<{ id: string; secret: string }> {
  const r = await browser.json("/v1/tokens", { body: { name, role } });
  return { id: r.token.id, secret: r.secret };
}

function post(path: string, body: string, auth?: string): Promise<Response> {
  clock.advance(1);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.authorization = auth;
  return app.request(path, { method: "POST", headers, body });
}

const bearer = (secret: string) => `Bearer ${secret}`;
const basic = (secret: string) => `Basic ${Buffer.from(`user:${secret}`).toString("base64")}`;

async function ingestOf(browser: Browser): Promise<any[]> {
  return (await browser.json("/v1/activity/ingest?limit=200")).entries;
}

beforeEach(async () => {
  clock = new TestClock();
  const booted = await bootApp(clock);
  ({ ctx, app } = booted);
  owner = await setupOwner(app, booted.setupCode);
  const ws = (await owner.browser.json("/v1/workspaces")).workspaces[0].id;
  const { url } = await owner.browser.json(`/v1/workspaces/${ws}/invites`, { body: { role: "member" } });
  mina = (await signUpByInvite(app, url, "Mina")).browser;
  phone = await mint(owner.browser, "Pixel");
});

describe("ingest log", () => {
  it("records each outcome on each route, newest first", async () => {
    expect((await post("/v1/ingest", JSON.stringify({ lat: +LAT, lon: +LON }), bearer(phone.secret))).status).toBe(200);
    expect((await post("/v1/ingest/shortcut", "not json", bearer(phone.secret))).status).toBe(400);
    const location = JSON.stringify({ _type: "location", lat: +LAT, lon: +LON, tst: 1 });
    expect((await post("/v1/ingest/owntracks", location, basic(phone.secret))).status).toBe(200);
    expect((await post("/v1/ingest/owntracks", JSON.stringify({ _type: "waypoint" }), basic(phone.secret))).status).toBe(200);
    const outOfRange = JSON.stringify({ _type: "location", lat: +LAT, lon: 200, tst: 1 });
    expect((await post("/v1/ingest/owntracks", outOfRange, basic(phone.secret))).status).toBe(200);

    const entries = await ingestOf(owner.browser);
    expect(entries.map((e) => [e.source, e.outcome])).toEqual([
      ["owntracks", "rejected"],
      ["owntracks", "ignored"],
      ["owntracks", "accepted"],
      ["shortcut", "rejected"],
      ["generic", "accepted"],
    ]);
    expect(entries.every((e) => e.token?.name === "Pixel" && e.token.id === phone.id)).toBe(true);
    expect(entries[3].reason).toMatch(/valid JSON/);
    expect(entries[0].reason).toMatch(/out of range/);
    expect(recentLogs().filter((e) => /owntracks/i.test(e.msg))).toEqual([]);
  });

  it("never stores coordinates, not even inside a rejection message", async () => {
    await post("/v1/ingest", JSON.stringify({ lat: +LAT, lon: +LON }), bearer(phone.secret));
    await post("/v1/ingest", JSON.stringify({ lat: +LAT, lon: 500 }), bearer(phone.secret));
    const columns = await ctx.handle.client.execute("SELECT name FROM pragma_table_info('ingest_log')");
    const names = columns.rows.map((r) => String(r.name));
    expect(names.filter((n) => /lat|lon|coord|precise/i.test(n))).toEqual([]);
    const rows = await ctx.handle.client.execute("SELECT * FROM ingest_log");
    expect(rows.rows).toHaveLength(2);
    const dump = JSON.stringify(rows.rows);
    expect(dump).not.toContain(LAT);
    expect(dump).not.toContain(LON);
    expect(dump).not.toContain("500");
  });

  it("records a credential that may not write as rejected, and an unknown one not at all", async () => {
    const agent = await mint(owner.browser, "Bot", "agent");
    expect((await post("/v1/ingest", JSON.stringify({ lat: 1, lon: 1 }), bearer(agent.secret))).status).toBe(403);
    expect((await post("/v1/ingest", JSON.stringify({ lat: 1, lon: 1 }), bearer("wctx_nope"))).status).toBe(401);
    expect((await post("/v1/ingest", JSON.stringify({ lat: 1, lon: 1 }))).status).toBe(401);
    const entries = await ingestOf(owner.browser);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "rejected", token: { name: "Bot" } });
    expect(entries[0].reason).toMatch(/write_location/);
  });

  it("names no token for a reading posted from the dashboard", async () => {
    await owner.browser.json("/v1/ingest", { body: { source: "manual", lat: 1, lon: 1 } });
    const [entry] = await ingestOf(owner.browser);
    expect(entry).toMatchObject({ outcome: "accepted", token: null, source: "generic" });
  });

  it("records a server failure as rejected", async () => {
    vi.spyOn(ctx.system.service, "processReading").mockRejectedValueOnce(new Error("db locked"));
    expect((await post("/v1/ingest", JSON.stringify({ lat: 1, lon: 1 }), bearer(phone.secret))).status).toBe(500);
    const [entry] = await ingestOf(owner.browser);
    expect(entry).toMatchObject({ outcome: "rejected", reason: "internal server error" });
  });
});

describe("GET /v1/devices", () => {
  it("summarises each device's last upload and its last 24 hours", async () => {
    const tablet = await mint(owner.browser, "iPad");
    await post("/v1/ingest", JSON.stringify({ lat: 1, lon: 1 }), bearer(phone.secret));
    clock.advance(2 * DAY);
    await post("/v1/ingest", JSON.stringify({ lat: 1, lon: 1 }), bearer(phone.secret));
    await post("/v1/ingest", "{", bearer(phone.secret));
    const lastAt = new Date(clock.now).toISOString();
    const { devices } = await owner.browser.json("/v1/devices");
    expect(devices.map((d: any) => d.name)).toEqual(["Pixel", "iPad"]);
    expect(devices[0]).toMatchObject({
      id: phone.id,
      lastReceivedAt: lastAt,
      lastOutcome: "rejected",
      accepted24h: 1,
      rejected24h: 1,
    });
    expect(devices[1]).toMatchObject({ id: tablet.id, lastReceivedAt: null, lastOutcome: null, accepted24h: 0 });
  });
});

describe("isolation", () => {
  it("shows each person only their own uploads and devices", async () => {
    const hers = await mint(mina, "Mina's phone");
    await post("/v1/ingest", JSON.stringify({ lat: 1, lon: 1 }), bearer(phone.secret));
    await post("/v1/ingest", JSON.stringify({ lat: 1, lon: 1 }), bearer(hers.secret));
    expect((await ingestOf(owner.browser)).map((e) => e.token.name)).toEqual(["Pixel"]);
    expect((await ingestOf(mina)).map((e) => e.token.name)).toEqual(["Mina's phone"]);
    expect((await mina.json("/v1/devices")).devices.map((d: any) => d.name)).toEqual(["Mina's phone"]);
  });

  it("refuses tokens on the ingest log", async () => {
    const admin = await mint(owner.browser, "admin", "admin");
    const res = await app.request("/v1/activity/ingest", { headers: { authorization: bearer(admin.secret) } });
    expect(res.status).toBe(403);
  });
});

describe("retention", () => {
  it("prunes uploads older than the window", async () => {
    await post("/v1/ingest", JSON.stringify({ lat: 1, lon: 1 }), bearer(phone.secret));
    clock.advance(8 * DAY);
    await post("/v1/ingest", JSON.stringify({ lat: 1, lon: 1 }), bearer(phone.secret));
    expect(await ctx.system.ingestLog.prune(7)).toBe(1);
    expect(await ingestOf(owner.browser)).toHaveLength(1);
  });
});
