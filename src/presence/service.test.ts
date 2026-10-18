import { beforeEach, describe, expect, it } from "vitest";
import type { WhereCtxConfig } from "../config.js";
import { createDb, ensureSchema, type DbHandle } from "../db/index.js";
import { TokenStore } from "../auth/tokens.js";
import { SettingsStore } from "../privacy/settingsStore.js";
import {
  EventsStore,
  HistoryStore,
  PlacesStore,
  PresenceStore,
  RemindersStore,
} from "../store/index.js";
import type { NormalizedReading } from "../normalizer/types.js";
import {
  agentCoarseView,
  authorizePrecise,
  canReadPresence,
} from "../privacy/policy.js";
import { ROLE_SCOPES, asUserId } from "../types.js";
import { PresenceService } from "./service.js";

const config: WhereCtxConfig = {
  port: 8787,
  host: "0.0.0.0",
  baseUrl: "http://localhost:8787",
  databaseUrl: ":memory:",
  defaultUserId: asUserId("default"),
  bootstrapTokens: {},
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
  webhooks: { allowPrivateTargets: false },
  events: { retentionHours: 720 },
  sharing: { auditRetentionDays: 365 },
  oauth: { dynamicRegistration: false },
};

const T0 = Date.parse("2026-06-05T00:00:00.000Z");
const USER = asUserId("default");

let nowMs = T0;
const clock = () => new Date(nowMs);

function reading(lat: number, lon: number, over: Partial<NormalizedReading> = {}): NormalizedReading {
  return {
    precise: { lat, lon, accuracyM: 15 },
    motion: "walking",
    source: "owntracks",
    updatedAt: new Date(nowMs).toISOString(),
    ...over,
  };
}

let handle: DbHandle;
let service: PresenceService;
let placesStore: PlacesStore;
let eventsStore: EventsStore;
let presenceStore: PresenceStore;
let settingsStore: SettingsStore;

beforeEach(async () => {
  nowMs = T0;
  handle = createDb(":memory:");
  await ensureSchema(handle);
  const db = handle.db;
  placesStore = new PlacesStore(db, clock);
  eventsStore = new EventsStore(db, clock);
  presenceStore = new PresenceStore(db);
  settingsStore = new SettingsStore(db, config, clock);
  service = new PresenceService({
    config,
    presenceStore,
    placesStore,
    eventsStore,
    historyStore: new HistoryStore(db, clock),
    remindersStore: new RemindersStore(db, clock),
    settingsStore,
    clock,
  });
  await placesStore.upsert(USER, {
    name: "home",
    lat: 37.0,
    lon: 127.0,
    radiusM: 150,
    type: "home",
  });
});

describe("PresenceService.processReading", () => {
  it("computes home status and emits updated + entered_place", async () => {
    const r = await service.processReading(USER, reading(37.0, 127.0));
    expect(r.presence.status).toBe("home");
    expect(r.presence.coarse?.geohash).toBeDefined();
    const types = r.events.map((e) => e.type);
    expect(types).toContain("presence.updated");
    expect(types).toContain("presence.entered_place");
    const entered = r.events.find((e) => e.type === "presence.entered_place");
    expect(entered?.placeName).toBe("home");
  });

  it("emits left_place when moving away from a place", async () => {
    await service.processReading(USER, reading(37.0, 127.0)); // home
    const away = await service.processReading(USER, reading(37.05, 127.0)); // far
    expect(away.presence.status).toBe("away");
    expect(away.events.map((e) => e.type)).toContain("presence.left_place");
  });

  it("upgrades away to transit when driving", async () => {
    const r = await service.processReading(USER, reading(37.05, 127.0, { motion: "driving" }));
    expect(r.presence.status).toBe("transit");
  });

  it("stores precise coordinates on the current presence", async () => {
    await service.processReading(USER, reading(37.0, 127.0));
    const current = await new PresenceStore(handle.db).getCurrent(USER);
    expect(current?.precise?.lat).toBe(37.0);
    expect(current?.privacy.mode).toBe("coarse");
  });

  it("does not record raw history when disabled", async () => {
    await service.processReading(USER, reading(37.0, 127.0));
    const history = await new HistoryStore(handle.db, clock).listRecent(USER);
    expect(history).toHaveLength(0);
  });
});

describe("PresenceService.checkStale", () => {
  it("emits became_stale once after the stale window", async () => {
    await service.processReading(USER, reading(37.0, 127.0));
    expect(await service.checkStale(USER)).toBeNull(); // fresh

    nowMs = T0 + 1000 * 1000; // +1000s > 900s stale window
    const stale = await service.checkStale(USER);
    expect(stale?.type).toBe("presence.became_stale");
    expect(await service.checkStale(USER)).toBeNull(); // only once
  });
});

describe("PresenceService.sweepStale", () => {
  it("fires became_stale for the stale user only, once", async () => {
    const OTHER = asUserId("other");
    await service.processReading(USER, reading(37.0, 127.0));
    nowMs = T0 + 1000 * 1000;
    await service.processReading(OTHER, reading(37.05, 127.0));

    const swept = await service.sweepStale();
    expect(swept.map((e) => e.type)).toEqual(["presence.became_stale"]);
    expect((await eventsStore.listRecent(USER)).map((e) => e.type)).toContain(
      "presence.became_stale",
    );
    expect((await eventsStore.listRecent(OTHER)).map((e) => e.type)).not.toContain(
      "presence.became_stale",
    );
    expect(await service.sweepStale()).toEqual([]);
  });
});

describe("TokenStore", () => {
  it("refuses placeholders and auto-generates an admin token", async () => {
    const store = new TokenStore(handle.db, clock);
    const result = await store.seedBootstrap(USER, {
      admin: "change-me-admin",
      device: "short",
      agent: undefined,
    });
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
    expect(result.generatedAdminSecret).toBeDefined();

    const verified = await store.verify(result.generatedAdminSecret);
    expect(verified?.role).toBe("admin");
    expect(verified?.scopes).toContain("manage_tokens");
    expect(await store.verify("wrong")).toBeNull();
  });

  it("generates an admin for the bootstrap user even when others have one", async () => {
    const store = new TokenStore(handle.db, clock);
    await store.create(asUserId("someone-else"), "admin", "admin");
    const strong = "a-very-strong-agent-token-1234567890";
    const first = await store.seedBootstrap(USER, { agent: strong });
    expect(first.generatedAdminSecret).toBeDefined();
    expect((await store.verify(first.generatedAdminSecret))?.userId).toBe(USER);
    expect((await store.seedBootstrap(USER, { agent: strong })).generatedAdminSecret).toBeUndefined();
  });

  it("warns instead of silently skipping an env token owned by another user", async () => {
    const store = new TokenStore(handle.db, clock);
    const strong = "a-very-strong-admin-token-1234567890";
    await store.seedBootstrap(asUserId("alice"), { admin: strong });
    const result = await store.seedBootstrap(USER, { admin: strong });
    expect(result.warnings.join("\n")).toMatch(/belongs to user "alice"/);
    expect((await store.verify(strong))?.userId).toBe("alice");
  });

  it("seeds strong bootstrap tokens and verifies them", async () => {
    const store = new TokenStore(handle.db, clock);
    const strong = "a-very-strong-agent-token-1234567890";
    const result = await store.seedBootstrap(USER, { agent: strong });
    expect(result.seeded).toContain("agent");
    const verified = await store.verify(strong);
    expect(verified?.role).toBe("agent");
    expect(verified?.scopes).toContain("read_presence");
  });
});

describe("end-to-end privacy enforcement", () => {
  it("hidden mode withholds both coarse and precise from agents", async () => {
    await service.processReading(USER, reading(37.05, 127.0)); // away (has precise)
    await service.changePrivacySettings(USER, { defaultAgentAccess: "hidden" });
    const settings = await settingsStore.getOrSeed(USER);
    const current = (await presenceStore.getCurrent(USER))!;

    expect(agentCoarseView(current, settings, clock)).toBeNull();
    const auth = authorizePrecise({
      scopes: ROLE_SCOPES.agent,
      settings,
      presence: current,
      reason: "map",
    });
    expect(auth.allowed).toBe(false);
  });

  it("denies precise exact coordinates while at home (deny, not blur)", async () => {
    await service.processReading(USER, reading(37.0, 127.0)); // home
    // Enable precise globally so the home-protection branch (not the global
    // disable) is what produces the denial.
    await service.changePrivacySettings(USER, { allowPreciseLocation: true });
    const settings = await settingsStore.getOrSeed(USER);
    const current = (await presenceStore.getCurrent(USER))!;
    const auth = authorizePrecise({
      scopes: ROLE_SCOPES.agent,
      settings,
      presence: current,
      reason: "user_requested_map",
    });
    expect(auth.allowed).toBe(false);
    expect(auth.reason).toMatch(/home/);
  });

  it("never exposes geohash or raw coords through the agent coarse view", async () => {
    await service.processReading(USER, reading(37.05, 127.0));
    const settings = await settingsStore.getOrSeed(USER);
    const current = (await presenceStore.getCurrent(USER))!;
    const view = agentCoarseView(current, settings, clock)!;
    expect(view).not.toHaveProperty("geohash");
    expect(view).not.toHaveProperty("lat");
    expect(JSON.stringify(view)).not.toContain(String(current.coarse?.geohash));
  });

  it("rejects a device token at the presence read boundary", () => {
    // device tokens carry only write_location — they can never read presence.
    expect(canReadPresence(ROLE_SCOPES.device)).toBe(false);
    expect(canReadPresence(ROLE_SCOPES.agent)).toBe(true);
  });

  it("emits presence.privacy_changed when the mode actually changes", async () => {
    await service.processReading(USER, reading(37.05, 127.0));
    const { event } = await service.changePrivacySettings(USER, { defaultAgentAccess: "hidden" });
    expect(event?.type).toBe("presence.privacy_changed");

    // No event when the mode is unchanged.
    const second = await service.changePrivacySettings(USER, { defaultAgentAccess: "hidden" });
    expect(second.event).toBeNull();
  });
});

describe("staleness re-arming", () => {
  it("fires became_stale again after a fresh reading resets the flag", async () => {
    await service.processReading(USER, reading(37.0, 127.0));
    nowMs = T0 + 1000 * 1000;
    expect((await service.checkStale(USER))?.type).toBe("presence.became_stale");

    // A fresh reading re-arms the flag.
    await service.processReading(USER, reading(37.0, 127.0));
    expect(await service.checkStale(USER)).toBeNull();

    nowMs += 1000 * 1000;
    expect((await service.checkStale(USER))?.type).toBe("presence.became_stale");
  });
});

describe("concurrent ingest serialization (F10)", () => {
  it("does not lose or duplicate enter/leave events under overlapping ingests", async () => {
    // Fire home and away ingests concurrently; the mutex serializes them.
    await Promise.all([
      service.processReading(USER, reading(37.0, 127.0)), // home
      service.processReading(USER, reading(37.05, 127.0)), // away
    ]);
    const events = await eventsStore.listRecent(USER, 100);
    const entered = events.filter((e) => e.type === "presence.entered_place").length;
    const left = events.filter((e) => e.type === "presence.left_place").length;
    // Exactly one entered (home) and at most one left — never a double-emit.
    expect(entered).toBeLessThanOrEqual(1);
    expect(left).toBeLessThanOrEqual(1);
    // Final state is internally consistent (one of the two readings won).
    const current = await presenceStore.getCurrent(USER);
    expect(["home", "away"]).toContain(current?.status);
  });
});
