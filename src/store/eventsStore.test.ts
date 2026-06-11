import { beforeEach, describe, expect, it } from "vitest";
import { createDb, ensureSchema, type DbHandle } from "../db/index.js";
import { EventsStore } from "./eventsStore.js";

let nowMs = Date.parse("2026-06-05T00:00:00.000Z");
const clock = () => new Date(nowMs);

let handle: DbHandle;
let events: EventsStore;

beforeEach(async () => {
  nowMs = Date.parse("2026-06-05T00:00:00.000Z");
  handle = createDb(":memory:");
  await ensureSchema(handle);
  events = new EventsStore(handle.db, clock);
});

describe("EventsStore", () => {
  it("appendMany inserts a batch in one call and returns stored events in order", async () => {
    const stored = await events.appendMany([
      { type: "presence.updated", status: "home" },
      { type: "presence.left_place", placeName: "work" },
      { type: "presence.entered_place", placeName: "home" },
    ]);
    expect(stored.map((e) => e.type)).toEqual([
      "presence.updated",
      "presence.left_place",
      "presence.entered_place",
    ]);
    expect(await events.listRecent()).toHaveLength(3);
  });

  it("appendMany with an empty batch is a no-op", async () => {
    expect(await events.appendMany([])).toEqual([]);
    expect(await events.listRecent()).toHaveLength(0);
  });

  it("prune removes only events older than the retention window", async () => {
    await events.append({ type: "presence.updated", status: "home" });
    nowMs += 48 * 3600 * 1000; // two days later
    await events.append({ type: "presence.updated", status: "away" });

    const removed = await events.prune(24);
    expect(removed).toBe(1);
    const remaining = await events.listRecent();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.status).toBe("away");
  });
});
