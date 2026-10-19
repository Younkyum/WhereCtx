import { beforeEach, describe, expect, it } from "vitest";
import type { WhereCtxConfig } from "../config.js";
import { createDb, ensureSchema, type DbHandle } from "../db/index.js";
import { places as placesTable } from "../db/schema.js";
import { SettingsStore } from "../privacy/settingsStore.js";
import { EventsStore, HistoryStore, PlacesStore, PresenceStore, RemindersStore, toPresenceContext } from "../store/index.js";
import { authorizePrecise, presenceViews } from "../privacy/policy.js";
import type { PlaceInput } from "../store/placesStore.js";
import type { NormalizedReading } from "../normalizer/types.js";
import { asUserId, type PresenceEvent } from "../types.js";
import { PresenceService } from "./service.js";

const config = {
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
} as WhereCtxConfig;

const T0 = Date.parse("2026-06-05T00:00:00.000Z");
const USER = asUserId("default");
const GYM = { lat: 37.5, lon: 127.0 };
const M_PER_DEG_LAT = 111_195;
/** A point `m` meters north of the gym's center. */
const north = (m: number) => ({ lat: GYM.lat + m / M_PER_DEG_LAT, lon: GYM.lon });

let nowMs = T0;
const clock = () => new Date(nowMs);
const advance = (sec: number) => {
  nowMs += sec * 1000;
};

function reading(at: { lat: number; lon: number }, over: Partial<NormalizedReading> = {}): NormalizedReading {
  return {
    precise: { lat: at.lat, lon: at.lon, accuracyM: 10 },
    motion: "stationary",
    source: "owntracks",
    updatedAt: new Date(nowMs).toISOString(),
    ...over,
  };
}

let handle: DbHandle;
let places: PlacesStore;
let events: EventsStore;
let presence: PresenceStore;
let reminders: RemindersStore;
let service: PresenceService;

function newService(): PresenceService {
  return new PresenceService({
    config,
    presenceStore: presence,
    placesStore: places,
    eventsStore: events,
    historyStore: new HistoryStore(handle.db, clock),
    remindersStore: reminders,
    settingsStore: new SettingsStore(handle.db, config, clock),
    clock,
  });
}

const gym = (over: Partial<PlaceInput> = {}) =>
  places.upsert(USER, { name: "gym", type: "custom", ...GYM, radiusM: 100, ...over });

const typesOf = (evs: PresenceEvent[]) => evs.map((e) => e.type);
const placeEvents = (evs: PresenceEvent[]) =>
  evs.filter((e) => e.type !== "presence.updated").map((e) => `${e.type.replace("presence.", "")} ${e.placeName}`);

beforeEach(async () => {
  nowMs = T0;
  handle = createDb(":memory:");
  await ensureSchema(handle);
  places = new PlacesStore(handle.db, clock);
  events = new EventsStore(handle.db, clock);
  presence = new PresenceStore(handle.db);
  reminders = new RemindersStore(handle.db, clock);
  service = newService();
});

describe("a delayed enter", () => {
  it("is confirmed by the sweep with no new reading, and fires the place's reminders then", async () => {
    await gym({ enterAfterSec: 120 });
    await reminders.create(USER, "gym", "stretch");
    const first = await service.processReading(USER, reading(north(0)));
    expect(first.presence.status).toBe("away");
    expect(placeEvents(first.events)).toEqual([]);

    advance(60);
    expect(await service.sweepDwell()).toEqual([]);
    advance(60);
    const swept = await service.sweepDwell();
    expect(placeEvents(swept)).toEqual(["entered_place gym"]);
    expect(typesOf(swept)).toContain("presence.updated");
    expect((await presence.getCurrent(USER))!).toMatchObject({ status: "custom", label: "gym", currentPlaceName: "gym" });
    expect(await reminders.listActive(USER)).toEqual([]);
    expect(await service.sweepDwell()).toEqual([]);
  });

  it("is not confirmed by the sweep while the last reading is driving past, but a stopped reading confirms it", async () => {
    await gym({ enterAfterSec: 60 });
    await service.processReading(USER, reading(north(0), { motion: "driving" }));
    advance(120);
    expect(await service.sweepDwell()).toEqual([]);
    expect((await presence.getCurrent(USER))!.status).toBe("transit");

    const stopped = await service.processReading(USER, reading(north(10), { motion: "stationary" }));
    expect(placeEvents(stopped.events)).toEqual(["entered_place gym"]);
  });

  it("is not confirmed by the sweep while the last reading moves faster than 3 m/s", async () => {
    await gym({ enterAfterSec: 60 });
    await service.processReading(USER, reading(north(0), { motion: "walking", precise: { ...north(0), speedMps: 8 } }));
    advance(120);
    expect(await service.sweepDwell()).toEqual([]);
  });

  it("is not confirmed by a place change while the last reading is driving past", async () => {
    await gym({ enterAfterSec: 120 });
    await service.processReading(USER, reading(north(0), { motion: "driving", precise: { ...north(0), accuracyM: 10, speedMps: 15 } }));
    advance(180);
    expect(await service.sweepDwell()).toEqual([]);
    await places.upsert(USER, { name: "elsewhere", type: "custom", lat: 0, lon: 0, radiusM: 100 });
    expect(placeEvents((await service.reevaluateCurrent(USER))!.events)).toEqual([]);
  });

  it("is not confirmed by a reading that is driving or fast, which may still start it", async () => {
    await gym({ enterAfterSec: 60 });
    await service.processReading(USER, reading(north(0)));
    advance(120);
    const fast = await service.processReading(USER, reading(north(5), { motion: "walking", precise: { ...north(5), speedMps: 9 } }));
    expect(placeEvents(fast.events)).toEqual([]);
    const driving = await service.processReading(USER, reading(north(5), { motion: "driving" }));
    expect(placeEvents(driving.events)).toEqual([]);
    const stopped = await service.processReading(USER, reading(north(5)));
    expect(placeEvents(stopped.events)).toEqual(["entered_place gym"]);
  });

  it("is entered at once by a driving reading when the place has no enter delay, as a plain geofence is", async () => {
    await gym();
    const driving = await service.processReading(USER, reading(north(0), { motion: "driving" }));
    expect(placeEvents(driving.events)).toEqual(["entered_place gym"]);
  });

  it("is judged by the stored point against the places as they are now, on a sweep too", async () => {
    await gym({ enterAfterSec: 120 });
    await service.processReading(USER, reading(north(0)));
    await handle.db.update(placesTable).set({ lat: 0, lon: 0 });
    advance(150);
    expect(placeEvents(await service.sweepDwell())).toEqual([]);
    expect((await presence.getCurrent(USER))!.pendingPlace).toBeUndefined();
  });

  it("survives a restart: a new service on the same database confirms it", async () => {
    await gym({ enterAfterSec: 120 });
    await service.processReading(USER, reading(north(0)));
    advance(150);
    const restarted = newService();
    expect(placeEvents(await restarted.sweepDwell())).toEqual(["entered_place gym"]);
  });

  it("starts when a place is created around where the person already is", async () => {
    await places.upsert(USER, { name: "home", type: "home", lat: 37.0, lon: 127.0, radiusM: 150 });
    await service.processReading(USER, reading(north(0)));
    await gym({ enterAfterSec: 120 });
    const reevaluated = await service.reevaluateCurrent(USER);
    expect(reevaluated?.events).toEqual([]);
    advance(120);
    expect(placeEvents(await service.sweepDwell())).toEqual(["entered_place gym"]);
  });
});

describe("a delayed leave", () => {
  it("keeps the place's status until the sweep confirms the leave", async () => {
    await gym({ exitAfterSec: 300 });
    await service.processReading(USER, reading(north(0)));
    advance(10);
    const out = await service.processReading(USER, reading(north(2000), { motion: "walking" }));
    expect(out.presence.status).toBe("custom");
    expect(placeEvents(out.events)).toEqual([]);

    advance(299);
    expect(await service.sweepDwell()).toEqual([]);
    advance(1);
    const swept = await service.sweepDwell();
    expect(placeEvents(swept)).toEqual(["left_place gym"]);
    expect((await presence.getCurrent(USER))!.status).toBe("away");
  });

  it("happens at once when the confirmed place is deleted", async () => {
    await gym({ exitAfterSec: 600 });
    await service.processReading(USER, reading(north(0)));
    await places.deleteByName(USER, "gym");
    const result = await service.reevaluateCurrent(USER);
    expect(placeEvents(result!.events)).toEqual(["left_place gym"]);
  });
});

describe("a place inside another", () => {
  const nested = async (gardenEnterAfterSec: number) => {
    await places.upsert(USER, { name: "home", type: "home", ...GYM, radiusM: 150 });
    await places.upsert(USER, { name: "garden", type: "custom", ...north(80), radiusM: 30, enterAfterSec: gardenEnterAfterSec });
  };

  it("keeps the outer place while the inner one's enter is pending, then hands over directly", async () => {
    await nested(300);
    await service.processReading(USER, reading(north(-100)));
    advance(60);
    const inGarden = await service.processReading(USER, reading(north(80)));
    expect(inGarden.presence.status).toBe("home");
    expect(placeEvents(inGarden.events)).toEqual([]);
    advance(60);
    expect(placeEvents((await service.processReading(USER, reading(north(80)))).events)).toEqual([]);
    advance(240);
    expect(placeEvents(await service.sweepDwell())).toEqual(["left_place home", "entered_place garden"]);
    expect((await presence.getCurrent(USER))!).toMatchObject({ status: "custom", currentPlaceName: "garden" });
  });

  it("hands over on the same reading when nothing is delayed, as a plain geofence does", async () => {
    await nested(0);
    await service.processReading(USER, reading(north(-100)));
    const inGarden = await service.processReading(USER, reading(north(80)));
    expect(placeEvents(inGarden.events)).toEqual(["left_place home", "entered_place garden"]);
  });
});

describe("place rules", () => {
  it("records only the place event types the place emits", async () => {
    await gym({ emits: ["presence.left_place"] });
    const entered = await service.processReading(USER, reading(north(0)));
    expect(placeEvents(entered.events)).toEqual([]);
    const left = await service.processReading(USER, reading(north(2000)));
    expect(placeEvents(left.events)).toEqual(["left_place gym"]);
  });

  it("keeps every event naming a place with notifyWebhooks off away from delivery, and still records it", async () => {
    await gym({ notifyWebhooks: false });
    await service.processReading(USER, reading(north(0)));
    await service.processReading(USER, reading(north(2000)));
    const recorded = (await events.listRecent(USER)).map((e) => `${e.type} ${e.placeName ?? "-"}`);
    expect(recorded).toEqual(
      expect.arrayContaining(["presence.entered_place gym", "presence.left_place gym", "presence.updated gym"]),
    );
    const deliverable = (await events.listSince(USER, null)).map((e) => `${e.type} ${e.placeName ?? "-"}`);
    expect(deliverable).toEqual(["presence.updated -"]);
  });

  it("treats a deleted place as quiet: its leave is recorded but never delivered, whatever it emitted", async () => {
    await gym({ notifyWebhooks: false, emits: ["presence.entered_place"] });
    await service.processReading(USER, reading(north(0)));
    await places.deleteByName(USER, "gym");
    const result = await service.reevaluateCurrent(USER);
    expect(placeEvents(result!.events)).toEqual(["left_place gym"]);
    expect((await presence.getCurrent(USER))!.currentPlaceName).toBeUndefined();
    const deliverable = (await events.listSince(USER, null)).map((e) => `${e.type} ${e.placeName ?? "-"}`);
    expect(deliverable.filter((e) => e.includes("gym"))).toEqual([]);
  });

  it("keeps the leave of a place deleted before the next reading away from delivery too", async () => {
    await gym({ exitAfterSec: 600 });
    await service.processReading(USER, reading(north(0)));
    advance(10);
    await service.processReading(USER, reading(north(2000), { motion: "walking" }));
    await handle.db.delete(placesTable);
    advance(10);
    const later = await service.processReading(USER, reading(north(2100), { motion: "walking" }));
    expect(placeEvents(later.events)).toEqual(["left_place gym"]);
    const deliverable = (await events.listSince(USER, null)).map((e) => `${e.type} ${e.placeName ?? "-"}`);
    expect(deliverable.filter((e) => e.startsWith("presence.left_place"))).toEqual([]);
  });

  it("never triggers reminders for a place with notifyReminders off", async () => {
    await gym({ notifyReminders: false });
    await reminders.create(USER, "gym", "stretch");
    const result = await service.processReading(USER, reading(north(0)));
    expect(placeEvents(result.events)).toEqual(["entered_place gym"]);
    expect(result.triggeredReminders).toEqual([]);
    expect(await reminders.listActive(USER)).toHaveLength(1);
  });

  it("fires approaching once as readings close in on a place with an approach ring", async () => {
    await gym({ approachM: 500 });
    await service.processReading(USER, reading(north(1500), { motion: "walking" }));
    const closer = await service.processReading(USER, reading(north(500), { motion: "walking" }));
    expect(placeEvents(closer.events)).toEqual(["approaching_place gym"]);
    const closerStill = await service.processReading(USER, reading(north(300), { motion: "walking" }));
    expect(placeEvents(closerStill.events)).toEqual([]);
  });
});

describe("home coordinate protection", () => {
  const preciseSettings = async () => ({
    ...(await new SettingsStore(handle.db, config, clock).getOrSeed(USER)),
    defaultAgentAccess: "precise" as const,
    allowPreciseLocation: true,
    preciseRequiresApproval: false,
    hideHomeExactCoordinates: true,
  });

  it("holds while standing at home even though the presence still counts a cafe whose leave is pending", async () => {
    await places.upsert(USER, { name: "home", type: "home", ...GYM, radiusM: 100 });
    await places.upsert(USER, { name: "cafe", type: "custom", ...north(500), radiusM: 60, exitAfterSec: 600 });
    await service.processReading(USER, reading(north(500)));
    advance(60);
    const atHome = await service.processReading(USER, reading(north(0)));
    expect(atHome.presence.status).toBe("custom");

    const stored = toPresenceContext((await presence.getCurrent(USER))!);
    const auth = authorizePrecise({ scopes: ["read_precise_location"], settings: await preciseSettings(), presence: stored, reason: "x" });
    expect(auth).toMatchObject({ allowed: false, outcome: "denied" });
    const shared = presenceViews(config.privacy, clock).person(
      stored,
      { level: "precise", hideHomeExact: true, showArea: false },
      { sharingPaused: false, hasHomePlace: true, geoEnabled: false },
    );
    expect(shared).toMatchObject({ precise: null, preciseWithheld: "at_home" });
  });

  it("holds while an arrival at home is pending inside a work place's near band", async () => {
    await places.upsert(USER, { name: "home", type: "home", ...GYM, radiusM: 300, enterAfterSec: 300 });
    await places.upsert(USER, { name: "work", type: "work", ...north(400), radiusM: 100 });
    await service.processReading(USER, reading(north(5000)));
    const arriving = await service.processReading(USER, reading(north(250)));
    expect(arriving.presence.status).toBe("near_work");

    const stored = toPresenceContext((await presence.getCurrent(USER))!);
    const auth = authorizePrecise({ scopes: ["read_precise_location"], settings: await preciseSettings(), presence: stored, reason: "x" });
    expect(auth).toMatchObject({ allowed: false, outcome: "denied" });
  });

  it("lets coordinates through away from home", async () => {
    await places.upsert(USER, { name: "home", type: "home", ...GYM, radiusM: 100 });
    await service.processReading(USER, reading(north(5000)));
    const stored = toPresenceContext((await presence.getCurrent(USER))!);
    const auth = authorizePrecise({ scopes: ["read_precise_location"], settings: await preciseSettings(), presence: stored, reason: "x" });
    expect(auth).toEqual({ allowed: true });
  });
});
