import { beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { AppContext } from "../app/context.js";
import { Browser, TestClock, bootApp, setupOwner, signUpByInvite, type Enrolled } from "../testing/accounts.js";
import { clearLogs, log } from "../util/log.js";
import { Secret } from "../util/secret.js";

const HOME = { lat: 37.5, lon: 127.0 };
const MINUTE = 60_000;

let clock: TestClock;
let app: Hono;
let ctx: AppContext;
let owner: Enrolled;
let mina: Browser;

async function mint(browser: Browser, name: string, role: string): Promise<string> {
  return (await browser.json("/v1/tokens", { body: { name, role } })).secret;
}

const asToken = (path: string, secret: string) => {
  clock.advance(1);
  return app.request(path, { headers: { authorization: `Bearer ${secret}` } });
};

async function walk(browser: Browser, points: Array<{ lat: number; lon: number }>): Promise<string[]> {
  const times: string[] = [];
  for (const p of points) {
    clock.advance(10 * MINUTE);
    times.push(new Date(clock.now).toISOString());
    await browser.json("/v1/ingest", { body: { source: "manual", ...p } });
  }
  return times;
}

const enableHistory = (browser: Browser) =>
  browser.json("/v1/privacy", { method: "PUT", body: { storeRawHistory: true, retentionHours: 48 } });

beforeEach(async () => {
  clock = new TestClock();
  const booted = await bootApp(clock);
  ({ app, ctx } = booted);
  owner = await setupOwner(app, booted.setupCode);
  const ws = (await owner.browser.json("/v1/workspaces")).workspaces[0].id;
  const { url } = await owner.browser.json(`/v1/workspaces/${ws}/invites`, { body: { role: "member" } });
  mina = (await signUpByInvite(app, url, "Mina")).browser;
  await owner.browser.json("/v1/places", { body: { name: "home", type: "home", ...HOME, radiusM: 100 } });
});

describe("GET /v1/presence/history", () => {
  it("says history is off and returns nothing while storeRawHistory is off", async () => {
    await walk(owner.browser, [HOME]);
    const res = await owner.browser.send("/v1/presence/history");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ enabled: false, points: [], truncated: false });
  });

  it("returns the range oldest first, naming the place each point fell in", async () => {
    await enableHistory(owner.browser);
    const away = { lat: 37.6, lon: 127.1 };
    const times = await walk(owner.browser, [HOME, away, HOME]);
    const body = await owner.browser.json("/v1/presence/history");
    expect(body.enabled).toBe(true);
    expect(body.retentionHours).toBe(48);
    expect(body.points.map((p: any) => [p.recordedAt, p.lat, p.place])).toEqual([
      [times[0], HOME.lat, "home"],
      [times[1], away.lat, undefined],
      [times[2], HOME.lat, "home"],
    ]);
    expect(body.points[0]).toMatchObject({ lon: HOME.lon, source: "manual" });
    expect(new Set(body.points.map((p: any) => p.id)).size).toBe(3);
    expect(body.points[0]).not.toHaveProperty("mapUrl");

    const middle = await owner.browser.json(
      `/v1/presence/history?from=${encodeURIComponent(times[1]!)}&to=${encodeURIComponent(times[1]!)}`,
    );
    expect(middle.points.map((p: any) => p.recordedAt)).toEqual([times[1]]);

    const capped = await owner.browser.json("/v1/presence/history?limit=2");
    expect(capped.points.map((p: any) => p.recordedAt)).toEqual([times[1], times[2]]);
    expect(capped.truncated).toBe(true);
  });

  it("defaults to the last 24 hours", async () => {
    await enableHistory(owner.browser);
    await walk(owner.browser, [HOME]);
    clock.advance(25 * 60 * MINUTE);
    await walk(owner.browser, [HOME]);
    expect((await owner.browser.json("/v1/presence/history")).points).toHaveLength(1);
  });

  it("includes a point a few minutes ahead of the server's clock in the default range", async () => {
    await enableHistory(owner.browser);
    const ahead = (ms: number) => new Date(clock.now + ms).toISOString();
    await ctx.system.history.append(ctx.config.defaultUserId, { lat: 1, lon: 1, recordedAt: ahead(3 * MINUTE) });
    await ctx.system.history.append(ctx.config.defaultUserId, { lat: 2, lon: 2, recordedAt: ahead(10 * MINUTE) });
    expect((await owner.browser.json("/v1/presence/history")).points.map((p: any) => p.lat)).toEqual([1]);
  });

  it.each(["yesterday", "2026-10-18", "2026-10-18T09:00:00", "1760000000000", "2026-10-18T09:00:00 +09:00"])(
    "refuses from=%s, which is not a date-time with an offset",
    async (from) => {
      expect((await owner.browser.send(`/v1/presence/history?from=${encodeURIComponent(from)}`)).status).toBe(400);
    },
  );

  it.each(["2026-10-17T09:00:00Z", "2026-10-17T18:00:00+09:00", "2026-10-17T09:00:00.123-07:00"])(
    "accepts from=%s",
    async (from) => {
      expect((await owner.browser.send(`/v1/presence/history?from=${encodeURIComponent(from)}`)).status).toBe(200);
    },
  );

  it("refuses unreadable or reversed ranges", async () => {
    expect((await owner.browser.send("/v1/presence/history?from=yesterday")).status).toBe(400);
    const reversed = "/v1/presence/history?from=2026-10-18T02:00:00Z&to=2026-10-18T01:00:00Z";
    expect((await owner.browser.send(reversed)).status).toBe(400);
  });

  it("shows each person only their own history, whatever they share", async () => {
    await enableHistory(owner.browser);
    await enableHistory(mina);
    const minaId = (await mina.json("/v1/me")).user.id;
    expect((await owner.browser.send(`/v1/shares/${minaId}`, { method: "PUT", body: { level: "precise" } })).status).toBe(200);
    await walk(owner.browser, [HOME]);
    expect((await mina.json("/v1/presence/history")).points).toEqual([]);
    await walk(mina, [{ lat: 1, lon: 1 }]);
    expect((await owner.browser.json("/v1/presence/history")).points.map((p: any) => p.lat)).toEqual([HOME.lat]);
  });

  it("refuses agent tokens and logs an admin token's read", async () => {
    const bot = await mint(owner.browser, "bot", "agent");
    const ops = await mint(owner.browser, "ops", "admin");
    await enableHistory(owner.browser);
    await walk(owner.browser, [HOME]);
    expect((await asToken("/v1/presence/history", bot)).status).toBe(403);
    expect((await asToken("/v1/presence/history", ops)).status).toBe(200);
    const { entries } = await owner.browser.json("/v1/activity/access");
    expect(entries.map((e: any) => [e.credential.name, e.action, e.outcome, e.precise])).toEqual([
      ["ops", "presence.history", "allowed", true],
      ["bot", "presence.history", "denied", true],
    ]);
  });
});

describe("history retention", () => {
  it("ages points out after history is turned off, on the sweep and on the next reading", async () => {
    await enableHistory(owner.browser);
    await walk(owner.browser, [HOME, HOME]);
    await owner.browser.json("/v1/privacy", { method: "PUT", body: { storeRawHistory: false } });
    const all = "/v1/presence/history?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z";
    expect((await owner.browser.json(all)).points).toHaveLength(2);

    clock.advance(48 * 60 * MINUTE);
    expect(await ctx.system.history.pruneExpired(24)).toBe(1);
    expect((await owner.browser.json(all)).points).toHaveLength(1);

    clock.advance(20 * MINUTE);
    await walk(owner.browser, [HOME]);
    expect((await owner.browser.json(all)).points).toHaveLength(0);
  });
});

describe("GET /v1/admin/logs", () => {
  it("shows the operator recent redacted entries, never a banner", async () => {
    clearLogs();
    log.banner`setup code ${new Secret("ABCD-EFGH-IJKL")}`;
    log.warn("upload refused", { token: "wctx_secretsecret", lat: 37.123456 });
    const res = await owner.browser.send("/v1/admin/logs");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = JSON.stringify(await res.json());
    expect(text).toContain("upload refused");
    expect(text).not.toContain("wctx_secretsecret");
    expect(text).not.toContain("37.123456");
    expect(text).not.toContain("ABCD-EFGH-IJKL");
  });

  it("filters by level and rejects an unknown one", async () => {
    clearLogs();
    log.info("quiet");
    log.error("loud");
    const { entries } = await owner.browser.json("/v1/admin/logs?level=warn");
    expect(entries.map((e: any) => e.msg)).toEqual(["loud"]);
    expect((await owner.browser.send("/v1/admin/logs?level=chatty")).status).toBe(400);
  });

  it("refuses everyone but the operator's session", async () => {
    expect((await mina.send("/v1/admin/logs")).status).toBe(403);
    expect((await asToken("/v1/admin/logs", await mint(owner.browser, "ops", "admin"))).status).toBe(403);
  });

  it("flags the operator in /v1/me", async () => {
    expect((await owner.browser.json("/v1/me")).isOperator).toBe(true);
    expect((await mina.json("/v1/me")).isOperator).toBe(false);
  });
});
