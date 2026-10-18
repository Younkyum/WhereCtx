import { beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { AppContext } from "./context.js";
import { asUserId } from "../types.js";
import { Browser, TestClock, bootApp, setupOwner, signUpByInvite, type Enrolled } from "../testing/accounts.js";
import { pruneOnce } from "./prune.js";

const DAY = 86_400_000;
const GHOST = asUserId("ghost-without-settings");

let clock: TestClock;
let ctx: AppContext;
let app: Hono;
let owner: Enrolled;
let mina: Browser;

const count = async (table: string): Promise<number> =>
  Number((await ctx.handle.client.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0]!.n);

beforeEach(async () => {
  clock = new TestClock();
  const booted = await bootApp(clock);
  ({ ctx, app } = booted);
  owner = await setupOwner(app, booted.setupCode);
  const ws = (await owner.browser.json("/v1/workspaces")).workspaces[0].id;
  const { url } = await owner.browser.json(`/v1/workspaces/${ws}/invites`, { body: { role: "member" } });
  mina = (await signUpByInvite(app, url, "Mina")).browser;
  agent = undefined as unknown as string;
  phone = undefined as unknown as string;
});

let agent: string;
let phone: string;

async function activity(): Promise<void> {
  agent ??= (await owner.browser.json("/v1/tokens", { body: { name: "bot", role: "agent" } })).secret;
  phone ??= (await owner.browser.json("/v1/tokens", { body: { name: "phone", role: "device" } })).secret;
  await app.request("/v1/presence", { headers: { authorization: `Bearer ${agent}` } });
  await app.request("/v1/ingest", {
    method: "POST",
    headers: { authorization: `Bearer ${phone}`, "content-type": "application/json" },
    body: JSON.stringify({ lat: 37.5, lon: 127 }),
  });
  await ctx.system.history.append(GHOST, { lat: 1, lon: 1, recordedAt: new Date(clock.now).toISOString() });
}

describe("pruneOnce", () => {
  it("ages out the access log, the ingest log, history and the share audit, each by its own window", async () => {
    await owner.browser.json("/v1/privacy", { method: "PUT", body: { storeRawHistory: true, retentionHours: 48 } });
    const minaId = (await mina.json("/v1/me")).user.id;
    await owner.browser.send(`/v1/shares/${minaId}`, { method: "PUT", body: { level: "coarse" } });
    await activity();
    expect(await count("access_log")).toBe(1);
    expect(await count("ingest_log")).toBe(1);
    expect(await count("location_history")).toBe(2);
    expect(await count("share_audit")).toBeGreaterThan(0);

    clock.advance(400 * DAY);
    const removed = await pruneOnce(ctx.system, ctx.config);

    expect(removed).toMatchObject({ accessLog: 1, ingestLog: 1, history: 2 });
    expect(removed.shareAudit).toBeGreaterThan(0);
    for (const table of ["access_log", "ingest_log", "location_history", "share_audit"]) {
      expect(await count(table), table).toBe(0);
    }
  });

  it("keeps rows still inside their windows", async () => {
    await owner.browser.json("/v1/privacy", { method: "PUT", body: { storeRawHistory: true, retentionHours: 48 } });
    await activity();
    clock.advance(30 * 3_600_000);
    const removed = await pruneOnce(ctx.system, ctx.config);
    expect(removed).toMatchObject({ accessLog: 0, ingestLog: 0, history: 1 });
    expect(await count("location_history")).toBe(1);
  });
});

describe("history pruneExpired", () => {
  it("prunes a user with no settings row by the default retention", async () => {
    await ctx.system.history.append(GHOST, { lat: 1, lon: 1, recordedAt: new Date(clock.now).toISOString() });
    clock.advance(23 * 3_600_000);
    expect(await ctx.system.history.pruneExpired(24)).toBe(0);
    clock.advance(2 * 3_600_000);
    expect(await ctx.system.history.pruneExpired(24)).toBe(1);
  });

  it("removes a backlog larger than one batch", async () => {
    for (let i = 0; i < 7; i++) {
      await ctx.system.history.append(GHOST, { lat: i, lon: i, recordedAt: new Date(clock.now - i).toISOString() });
    }
    clock.advance(2 * DAY);
    expect(await ctx.system.history.pruneExpired(24, 3)).toBe(7);
    expect(await count("location_history")).toBe(0);
  });
});
