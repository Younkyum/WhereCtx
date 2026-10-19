import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { AppContext } from "../app/context.js";
import type { NormalizedReading } from "../normalizer/types.js";
import { presenceViews } from "../privacy/policy.js";
import { toPresenceContext } from "../store/presenceStore.js";
import { asUserId, type IngestSource, type UserId } from "../types.js";
import { OWNER_ADMIN, TestClock, bootApp } from "../testing/accounts.js";

const AGENT = "agent-token-strong-0123456789abcdef-fresh";
const HOME = { lat: 37.5, lon: 127.0 };
const CAFE = { lat: 37.56, lon: 126.97 };
const HOUR = 3600_000;
const OWNER = asUserId("owner");
/** About 80 m north. */
const STEP = 0.00072;

let clock: TestClock;
let ctx: AppContext;
let app: Hono;

beforeEach(async () => {
  clock = new TestClock();
  ({ ctx, app } = await bootApp(clock, { bootstrapTokens: { admin: OWNER_ADMIN, agent: AGENT } }));
  await ctx.forUser(OWNER).places.upsert({ name: "home", type: "home", ...HOME, radiusM: 150 });
});

afterEach(() => ctx.handle.client.close());

function read(
  at: { lat: number; lon: number },
  source: IngestSource = "owntracks",
  motion?: NormalizedReading["motion"],
  takenAt: Date = clock.fn(),
) {
  return ctx.forUser(OWNER).presence.processReading({
    precise: { ...at, accuracyM: 10 },
    source,
    ...(motion ? { motion } : {}),
    updatedAt: takenAt.toISOString(),
  });
}

async function agentView(): Promise<any> {
  const res = await app.request("/v1/presence", { headers: { authorization: `Bearer ${AGENT}` } });
  return res.json();
}

async function sweptTypes(user: UserId = OWNER): Promise<string[]> {
  await ctx.system.service.sweepStale();
  return (await ctx.system.events.listRecent(user, 50)).map((e) => e.type);
}

describe("freshness for a phone that reports on movement", () => {
  it("is stationary, not stale, after three quiet hours at home", async () => {
    await read(HOME);
    clock.advance(3 * HOUR);
    const view = await agentView();
    expect(view).toMatchObject({ status: "home", stale: false, freshness: "stationary", lastReportAgoSec: 10_800, updatedAgoSec: 10_800 });
    expect(view).not.toHaveProperty("likelyStationary");
    expect(await sweptTypes()).not.toContain("presence.became_stale");
  });

  it("is stationary after a quiet hour away from any place: it would have reported a move", async () => {
    await read(CAFE);
    expect((await agentView()).freshness).toBe("live");
    clock.advance(HOUR);
    expect(await agentView()).toMatchObject({ freshness: "stationary", stale: false });
  });

  it("is unknown, not stationary, when it went quiet while driving", async () => {
    await read(CAFE, "owntracks", "driving");
    expect((await agentView()).freshness).toBe("live");
    clock.advance(HOUR);
    expect(await agentView()).toMatchObject({ freshness: "unknown", stale: false });
  });

  it("is offline, stale, and fires became_stale once, past DEVICE_OFFLINE_AFTER_SEC", async () => {
    await read(CAFE);
    clock.advance(24 * HOUR + 1000);
    expect(await agentView()).toMatchObject({ freshness: "offline", stale: true });
    expect((await sweptTypes()).filter((t) => t === "presence.became_stale")).toHaveLength(1);
    expect((await sweptTypes()).filter((t) => t === "presence.became_stale")).toHaveLength(1);
  });

  it("a ping refreshes the last report and keeps when they arrived, with no place transition", async () => {
    await read(HOME);
    clock.advance(2 * HOUR);
    const pinged = await read({ lat: HOME.lat + 0.0002, lon: HOME.lon });
    expect(pinged.events.map((e) => e.type)).toEqual(["presence.updated"]);
    expect(await agentView()).toMatchObject({ lastReportAgoSec: 0, lastMovedAgoSec: 7200, freshness: "stationary" });
    clock.advance(10 * 60_000);
    await read(CAFE, "owntracks", "driving");
    expect(await agentView()).toMatchObject({ lastMovedAgoSec: 0, freshness: "live" });
  });

  it("counts a slow drift of 80 m steps as moving, measured from where they arrived", async () => {
    await read(CAFE);
    clock.advance(10 * 60_000);
    await read({ lat: CAFE.lat + STEP, lon: CAFE.lon });
    expect((await agentView()).lastMovedAgoSec).toBe(600);
    clock.advance(10 * 60_000);
    await read({ lat: CAFE.lat + 2 * STEP, lon: CAFE.lon });
    expect((await agentView()).lastMovedAgoSec).toBe(0);
    clock.advance(10 * 60_000);
    await read({ lat: CAFE.lat + 3 * STEP, lon: CAFE.lon });
    expect((await agentView()).lastMovedAgoSec).toBe(600);
  });

  it("ages from when the server heard it, not the device's own timestamp", async () => {
    await read(CAFE, "owntracks", undefined, new Date(clock.fn().getTime() - 30 * HOUR));
    expect(await agentView()).toMatchObject({ lastReportAgoSec: 0, stale: false, freshness: "live" });
    await read(CAFE, "owntracks", undefined, new Date(clock.fn().getTime() + 5 * HOUR));
    clock.advance(25 * HOUR);
    expect(await agentView()).toMatchObject({ freshness: "offline", stale: true });
  });

  it("works its window out from the source and the config at read time, not from the stored row", async () => {
    await read(CAFE);
    await ctx.handle.client.execute("UPDATE presence SET stale_after_sec = 900");
    clock.advance(3 * HOUR);
    expect(await agentView()).toMatchObject({ freshness: "stationary", stale: false });
    expect(await sweptTypes()).not.toContain("presence.became_stale");

    const stored = toPresenceContext((await ctx.system.presence.getCurrent(OWNER))!);
    const tighter = presenceViews({ staleAfterSec: 900, deviceOfflineAfterSec: 2 * 3600 }, clock.fn);
    expect(tighter.freshness(stored)).toMatchObject({ freshness: "offline", stale: true });
  });
});

describe("freshness for a reading something else fires", () => {
  it.each(["manual", "ios_shortcut", "tasker"] as const)(
    "%s has no connection to go offline: past STALE_AFTER_SEC it is stale and unknown",
    async (source) => {
      await read(CAFE, source);
      expect((await agentView()).freshness).toBe("live");
      clock.advance(16 * 60_000);
      expect(await agentView()).toMatchObject({ freshness: "unknown", stale: true });
      expect((await sweptTypes()).filter((t) => t === "presence.became_stale")).toHaveLength(1);
    },
  );
});
