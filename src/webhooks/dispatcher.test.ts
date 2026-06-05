import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createDb, ensureSchema, type DbHandle } from "../db/index.js";
import { EventsStore } from "../store/eventsStore.js";
import { WebhooksStore } from "../store/webhooksStore.js";
import { WebhookDispatcher, type DispatcherOptions } from "./dispatcher.js";

let nowMs = Date.parse("2026-06-05T00:00:00.000Z");
const clock = () => new Date(nowMs);

let handle: DbHandle;
let events: EventsStore;
let webhooks: WebhooksStore;

// Resolver that always returns a public IP so the SSRF guard passes for the
// happy-path tests (they use non-resolvable example.test hostnames).
const publicResolver = async () => ["93.184.216.34"];

function makeDispatcher(over: Partial<DispatcherOptions> = {}): WebhookDispatcher {
  return new WebhookDispatcher({
    webhooksStore: webhooks,
    eventsStore: events,
    clock,
    urlResolver: publicResolver,
    ...over,
  });
}

beforeEach(async () => {
  nowMs = Date.parse("2026-06-05T00:00:00.000Z");
  handle = createDb(":memory:");
  await ensureSchema(handle);
  events = new EventsStore(handle.db, clock);
  webhooks = new WebhooksStore(handle.db, clock);
});

describe("WebhookDispatcher", () => {
  it("delivers events created after the cursor and advances it", async () => {
    await webhooks.create({ url: "https://example.test/hook", events: ["*"] });
    nowMs += 1000;
    await events.append({ type: "presence.updated", status: "home" });
    nowMs += 1; // distinct ms
    await events.append({ type: "presence.entered_place", placeName: "home" });

    const calls: Array<{ url: string; body: string }> = [];
    const fetchFn = vi.fn(async (url: string, init: any) => {
      calls.push({ url, body: init.body });
      return new Response(null, { status: 200 });
    });
    const dispatcher = makeDispatcher({ fetchFn: fetchFn as any });
    await dispatcher.tick();

    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0]!.body).event).toBe("presence.updated");

    await dispatcher.tick(); // cursor advanced -> nothing new
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does NOT drop sibling events that share a millisecond (composite cursor)", async () => {
    await webhooks.create({ url: "https://example.test/hook", events: ["*"] });
    nowMs += 1000;
    // Two events at the SAME createdAt (same nowMs) — the H2 boundary.
    await events.append({ type: "presence.updated", status: "home" });
    await events.append({ type: "presence.entered_place", placeName: "home" });

    // Deliver only the first event per tick, failing afterward, to force the
    // cursor to be persisted mid-cluster.
    let delivered = 0;
    const fetchFn = vi.fn(async () => {
      delivered += 1;
      return new Response(null, { status: delivered === 1 ? 200 : 500 });
    });
    const dispatcher = makeDispatcher({ fetchFn: fetchFn as any, maxAttempts: 99 });
    await dispatcher.tick(); // delivers #1 (200), #2 fails -> cursor at #1
    // Now let #2 succeed.
    (fetchFn as any).mockImplementation(async () => new Response(null, { status: 200 }));
    await dispatcher.tick(); // must still deliver #2 despite same ms as #1

    expect(delivered).toBeGreaterThanOrEqual(2);
    // Both event types eventually delivered.
    const bodies = (fetchFn.mock.calls as any[]).map((c) => JSON.parse(c[1].body).event);
    expect(bodies).toContain("presence.updated");
    expect(bodies).toContain("presence.entered_place");
  });

  it("delivers a filtered hook's enter event even when an updated shares its ms", async () => {
    await webhooks.create({ url: "https://example.test/hook", events: ["presence.entered_place"] });
    nowMs += 1000;
    await events.append({ type: "presence.updated", status: "home" }); // unsubscribed
    await events.append({ type: "presence.entered_place", placeName: "home" }); // subscribed, same ms

    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
    await makeDispatcher({ fetchFn: fetchFn as any }).tick();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchFn.mock.calls[0] as any)[1].body).event).toBe("presence.entered_place");
  });

  it("only delivers subscribed event types", async () => {
    await webhooks.create({ url: "https://example.test/hook", events: ["presence.entered_place"] });
    nowMs += 1000;
    await events.append({ type: "presence.updated", status: "home" });
    nowMs += 1;
    await events.append({ type: "presence.entered_place", placeName: "home" });

    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
    await makeDispatcher({ fetchFn: fetchFn as any }).tick();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("signs the payload with HMAC-SHA256 when a secret is set", async () => {
    const secret = "shhh-very-secret-value";
    await webhooks.create({ url: "https://example.test/hook", events: ["*"], secret });
    nowMs += 1000;
    await events.append({ type: "presence.updated", status: "home" });

    let captured: { body: string; sig?: string } | null = null;
    const fetchFn = vi.fn(async (_url: string, init: any) => {
      captured = { body: init.body, sig: init.headers["x-wherectx-signature"] };
      return new Response(null, { status: 200 });
    });
    await makeDispatcher({ fetchFn: fetchFn as any }).tick();

    const expected = "sha256=" + createHmac("sha256", secret).update(captured!.body).digest("hex");
    expect(captured!.sig).toBe(expected);
  });

  it("dead-letters an event after maxAttempts and advances past it", async () => {
    await webhooks.create({ url: "https://example.test/hook", events: ["*"] });
    nowMs += 1000;
    await events.append({ type: "presence.updated", status: "home" });

    const fetchFn = vi.fn(async () => new Response(null, { status: 500 }));
    const dispatcher = makeDispatcher({ fetchFn: fetchFn as any, maxAttempts: 2 });
    await dispatcher.tick(); // attempt 1
    await dispatcher.tick(); // attempt 2 -> dead-letter + advance

    const dead = await webhooks.listDeadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0]!.eventType).toBe("presence.updated");
    expect(dead[0]!.error).toContain("500");
  });

  it("refuses to deliver to a private/reserved target (SSRF) and dead-letters", async () => {
    await webhooks.create({ url: "https://internal.test/hook", events: ["*"] });
    nowMs += 1000;
    await events.append({ type: "presence.updated", status: "home" });

    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
    const dispatcher = makeDispatcher({
      fetchFn: fetchFn as any,
      maxAttempts: 1,
      allowPrivateTargets: false,
      urlResolver: async () => ["10.0.0.5"], // private
    });
    await dispatcher.tick();

    expect(fetchFn).not.toHaveBeenCalled(); // never actually POSTed
    const dead = await webhooks.listDeadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0]!.error).toMatch(/private|reserved/);
  });
});
