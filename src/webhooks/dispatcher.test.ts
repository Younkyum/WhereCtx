import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createDb, ensureSchema, type DbHandle } from "../db/index.js";
import { asUserId } from "../types.js";
import { EventsStore } from "../store/eventsStore.js";
import { WebhooksStore } from "../store/webhooksStore.js";
import { WebhookDispatcher, type DispatcherOptions } from "./dispatcher.js";
import { exampleDelivery } from "./payload.js";
import { SecretBox } from "./secretBox.js";

let nowMs = Date.parse("2026-06-05T00:00:00.000Z");
const clock = () => new Date(nowMs);

const USER = asUserId("default");

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

/** Auth headers exist only sealed, so tests that use one need a keyed store. */
function useKeyedStore(): void {
  beforeEach(() => {
    webhooks = new WebhooksStore(handle.db, clock, new SecretBox("dispatcher-test-key"));
  });
}

describe("WebhookDispatcher", () => {
  it("delivers events created after the cursor and advances it", async () => {
    await webhooks.create(USER, { url: "https://example.test/hook", events: ["*"] });
    nowMs += 1000;
    await events.append(USER, { type: "presence.updated", status: "home" });
    nowMs += 1; // distinct ms
    await events.append(USER, { type: "presence.entered_place", placeName: "home" });

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
    await webhooks.create(USER, { url: "https://example.test/hook", events: ["*"] });
    nowMs += 1000;
    // Two events at the SAME createdAt (same nowMs) — the H2 boundary.
    await events.append(USER, { type: "presence.updated", status: "home" });
    await events.append(USER, { type: "presence.entered_place", placeName: "home" });

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
    await webhooks.create(USER, { url: "https://example.test/hook", events: ["presence.entered_place"] });
    nowMs += 1000;
    await events.append(USER, { type: "presence.updated", status: "home" }); // unsubscribed
    await events.append(USER, { type: "presence.entered_place", placeName: "home" }); // subscribed, same ms

    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
    await makeDispatcher({ fetchFn: fetchFn as any }).tick();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchFn.mock.calls[0] as any)[1].body).event).toBe("presence.entered_place");
  });

  it("only delivers subscribed event types", async () => {
    await webhooks.create(USER, { url: "https://example.test/hook", events: ["presence.entered_place"] });
    nowMs += 1000;
    await events.append(USER, { type: "presence.updated", status: "home" });
    nowMs += 1;
    await events.append(USER, { type: "presence.entered_place", placeName: "home" });

    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
    await makeDispatcher({ fetchFn: fetchFn as any }).tick();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("signs `timestamp.body` with HMAC-SHA256 and exposes the timestamp", async () => {
    const secret = "shhh-very-secret-value";
    await webhooks.create(USER, { url: "https://example.test/hook", events: ["*"], secret });
    nowMs += 1000;
    await events.append(USER, { type: "presence.updated", status: "home" });

    let captured: { body: string; sig?: string; ts?: string } | null = null;
    const fetchFn = vi.fn(async (_url: string, init: any) => {
      captured = {
        body: init.body,
        sig: init.headers.get("x-wherectx-signature"),
        ts: init.headers.get("x-wherectx-timestamp"),
      };
      return new Response(null, { status: 200 });
    });
    await makeDispatcher({ fetchFn: fetchFn as any }).tick();

    // Timestamp comes from the injected clock; the signed payload is
    // `${timestamp}.${body}` so deliveries cannot be replayed indefinitely (M3).
    expect(captured!.ts).toBe(String(Math.floor(nowMs / 1000)));
    const expected =
      "sha256=" +
      createHmac("sha256", secret)
        .update(`${captured!.ts}.${captured!.body}`)
        .digest("hex");
    expect(captured!.sig).toBe(expected);
  });

  it("encrypts secrets at rest when a SecretBox is configured and still signs correctly", async () => {
    const { SecretBox } = await import("./secretBox.js");
    const box = new SecretBox("test-encryption-key");
    const store = new WebhooksStore(handle.db, clock, box);
    const secret = "shhh-very-secret-value";
    await store.create(USER, { url: "https://example.test/hook", events: ["*"], secret });

    // Raw row must not contain the plaintext secret.
    const raw = await handle.client.execute("SELECT secret FROM webhooks");
    const storedSecret = String(raw.rows[0]!["secret"]);
    expect(storedSecret).not.toContain(secret);
    expect(storedSecret.startsWith("enc:v1:")).toBe(true);

    nowMs += 1000;
    await events.append(USER, { type: "presence.updated", status: "home" });

    let captured: { body: string; sig?: string; ts?: string } | null = null;
    const fetchFn = vi.fn(async (_url: string, init: any) => {
      captured = {
        body: init.body,
        sig: init.headers.get("x-wherectx-signature"),
        ts: init.headers.get("x-wherectx-timestamp"),
      };
      return new Response(null, { status: 200 });
    });
    await makeDispatcher({ webhooksStore: store, fetchFn: fetchFn as any }).tick();

    // Signature must use the DECRYPTED secret.
    const expected =
      "sha256=" +
      createHmac("sha256", secret)
        .update(`${captured!.ts}.${captured!.body}`)
        .digest("hex");
    expect(captured!.sig).toBe(expected);
  });

  it("skips hooks whose secrets cannot be decrypted (fail closed)", async () => {
    const { SecretBox } = await import("./secretBox.js");
    const writeBox = new SecretBox("key-A");
    const writeStore = new WebhooksStore(handle.db, clock, writeBox);
    await writeStore.create(USER, { url: "https://example.test/hook", events: ["*"], secret: "s3cret-value" });

    // Same rows read with a DIFFERENT key -> hook must be excluded, not
    // delivered with a wrong signature.
    const readStore = new WebhooksStore(handle.db, clock, new SecretBox("key-B"));
    expect(await readStore.listActive()).toHaveLength(0);

    nowMs += 1000;
    await events.append(USER, { type: "presence.updated", status: "home" });
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
    await makeDispatcher({ webhooksStore: readStore, fetchFn: fetchFn as any }).tick();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("re-encrypts legacy plaintext secrets on demand", async () => {
    const secret = "legacy-plaintext-secret";
    await webhooks.create(USER, { url: "https://example.test/hook", events: ["*"], secret });

    const { SecretBox } = await import("./secretBox.js");
    const store = new WebhooksStore(handle.db, clock, new SecretBox("test-key"));
    expect(await store.encryptLegacySecrets()).toBe(1);
    expect(await store.encryptLegacySecrets()).toBe(0); // idempotent

    const raw = await handle.client.execute("SELECT secret FROM webhooks");
    expect(String(raw.rows[0]!["secret"]).startsWith("enc:v1:")).toBe(true);
    // Decrypted view still returns the original secret.
    const [hook] = await store.list(USER);
    expect(hook!.secret).toBe(secret);
  });

  it("dead-letters an event after maxAttempts and advances past it", async () => {
    await webhooks.create(USER, { url: "https://example.test/hook", events: ["*"] });
    nowMs += 1000;
    await events.append(USER, { type: "presence.updated", status: "home" });

    const fetchFn = vi.fn(async () => new Response(null, { status: 500 }));
    const dispatcher = makeDispatcher({ fetchFn: fetchFn as any, maxAttempts: 2 });
    await dispatcher.tick(); // attempt 1
    await dispatcher.tick(); // attempt 2 -> dead-letter + advance

    const dead = await webhooks.listDeadLetters(USER);
    expect(dead).toHaveLength(1);
    expect(dead[0]!.eventType).toBe("presence.updated");
    expect(dead[0]!.error).toContain("500");
  });

  it("refuses to deliver to a private/reserved target (SSRF) and dead-letters", async () => {
    await webhooks.create(USER, { url: "https://internal.test/hook", events: ["*"] });
    nowMs += 1000;
    await events.append(USER, { type: "presence.updated", status: "home" });

    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));
    const dispatcher = makeDispatcher({
      fetchFn: fetchFn as any,
      maxAttempts: 1,
      allowPrivateTargets: false,
      urlResolver: async () => ["10.0.0.5"], // private
    });
    await dispatcher.tick();

    expect(fetchFn).not.toHaveBeenCalled(); // never actually POSTed
    const dead = await webhooks.listDeadLetters(USER);
    expect(dead).toHaveLength(1);
    expect(dead[0]!.error).toMatch(/private|reserved/);
  });
});

describe("WebhookDispatcher scheduling", () => {
  const OTHER = asUserId("other");

  /** A fake endpoint per URL: "hang" waits until aborted, "ok" answers 200. */
  function endpoints(behavior: (url: string) => "hang" | "ok") {
    const delivered: Array<{ url: string; id: string }> = [];
    const hanging = new Set<string>();
    const fetchFn = (async (url: string, init: RequestInit) => {
      if (behavior(url) === "ok") {
        delivered.push({ url, id: JSON.parse(String(init.body)).id });
        return new Response(null, { status: 200 });
      }
      hanging.add(url);
      return new Promise<Response>((_, reject) => {
        init.signal!.addEventListener("abort", () => {
          hanging.delete(url);
          reject(new Error("aborted"));
        });
      });
    }) as unknown as typeof fetch;
    return { fetchFn, delivered, hanging };
  }

  it("delivers another user's new events while one user's endpoint hangs", async () => {
    await webhooks.create(USER, { url: "https://slow.test/hook", events: ["*"] });
    await webhooks.create(OTHER, { url: "https://fast.test/hook", events: ["*"] });
    nowMs += 1000;
    await events.append(USER, { type: "presence.updated", status: "home" });
    const first = await events.append(OTHER, { type: "presence.updated", status: "home" });

    const ep = endpoints((url) => (url.includes("slow") ? "hang" : "ok"));
    const dispatcher = makeDispatcher({ fetchFn: ep.fetchFn, timeoutMs: 60_000 });
    dispatcher.nudge();
    await vi.waitFor(() => expect(ep.delivered.map((d) => d.id)).toEqual([first.id]));

    nowMs += 1;
    const second = await events.append(OTHER, { type: "presence.entered_place", placeName: "home" });
    dispatcher.nudge();
    await vi.waitFor(() => expect(ep.delivered.map((d) => d.id)).toEqual([first.id, second.id]));
    expect(ep.hanging).toEqual(new Set(["https://slow.test/hook"]));

    await dispatcher.stop();
    expect(ep.hanging.size).toBe(0);
    expect(await webhooks.listDeadLetters(USER)).toEqual([]);
  });

  it("caps drains per user and in total", async () => {
    for (let i = 0; i < 3; i++) await webhooks.create(USER, { url: `https://a${i}.test/hook`, events: ["*"] });
    for (let i = 0; i < 3; i++) await webhooks.create(OTHER, { url: `https://b${i}.test/hook`, events: ["*"] });
    nowMs += 1000;
    await events.append(USER, { type: "presence.updated", status: "home" });
    await events.append(OTHER, { type: "presence.updated", status: "home" });

    const ep = endpoints(() => "hang");
    const dispatcher = makeDispatcher({
      fetchFn: ep.fetchFn,
      timeoutMs: 60_000,
      maxConcurrent: 3,
      perUserSlots: 2,
    });
    dispatcher.nudge();
    await vi.waitFor(() => expect(ep.hanging.size).toBe(3));
    await new Promise((r) => setTimeout(r, 20));
    const perUser = (prefix: string) => [...ep.hanging].filter((u) => u.startsWith(prefix)).length;
    expect(ep.hanging.size).toBe(3);
    expect(perUser("https://a")).toBe(2);
    expect(perUser("https://b")).toBe(1);
    await dispatcher.stop();
  });

  it("stops a drain at its time budget and resumes from the cursor", async () => {
    await webhooks.create(USER, { url: "https://example.test/hook", events: ["*"] });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      nowMs += 1000;
      ids.push((await events.append(USER, { type: "presence.updated", status: "home" })).id);
    }

    const delivered: string[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      delivered.push(JSON.parse(String(init.body)).id);
      nowMs += 4_000;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const dispatcher = makeDispatcher({ fetchFn, drainBudgetMs: 10_000 });

    await dispatcher.tick();
    expect(delivered).toEqual(ids.slice(0, 3));
    await dispatcher.tick();
    expect(delivered).toEqual(ids);
  });
});

describe("WebhookDispatcher cursor", () => {
  it("does not replay what happened while a hook was paused, when it is paused and resumed mid-drain", async () => {
    const hook = await webhooks.create(USER, { url: "https://example.test/hook", events: ["*"] });
    nowMs += 1000;
    await events.append(USER, { type: "presence.updated", status: "home" });
    const delivered: string[] = [];
    let first = true;
    const fetchFn = vi.fn(async (_url: string, init: any) => {
      delivered.push(JSON.parse(init.body).status);
      if (first) {
        first = false;
        await webhooks.update(USER, hook.id, { active: false });
        nowMs += 1000;
        await events.append(USER, { type: "presence.updated", status: "while-paused" });
        nowMs += 1000;
        await webhooks.update(USER, hook.id, { active: true });
      }
      return new Response(null, { status: 200 });
    });
    const dispatcher = makeDispatcher({ fetchFn: fetchFn as any });
    await dispatcher.tick();
    nowMs += 1000;
    await events.append(USER, { type: "presence.updated", status: "after" });
    await dispatcher.tick();
    await dispatcher.tick();
    expect(delivered).toEqual(["home", "after"]);
  });

  it("stops a drain when the hook stops wanting the next event's type", async () => {
    const hook = await webhooks.create(USER, {
      url: "https://example.test/hook",
      events: ["presence.updated", "presence.entered_place"],
    });
    nowMs += 1000;
    await events.append(USER, { type: "presence.updated", status: "home" });
    nowMs += 1;
    await events.append(USER, { type: "presence.entered_place", placeName: "home" });
    const delivered: string[] = [];
    const fetchFn = vi.fn(async (_url: string, init: any) => {
      delivered.push(JSON.parse(init.body).event);
      if (delivered.length === 1) await webhooks.update(USER, hook.id, { events: ["presence.updated"] });
      return new Response(null, { status: 200 });
    });
    const dispatcher = makeDispatcher({ fetchFn: fetchFn as any });
    await dispatcher.tick();
    await dispatcher.tick();
    expect(delivered.filter((e) => e === "presence.entered_place")).toEqual([]);
    expect(delivered[0]).toBe("presence.updated");
  });

  it("never moves a cursor backwards", async () => {
    const hook = await webhooks.create(USER, { url: "https://example.test/hook", events: ["*"] });
    expect(await webhooks.setCursor(hook, "2030-01-01T00:00:00.000Z", "b".repeat(32))).toBe(true);
    expect(await webhooks.setCursor(hook, "2029-01-01T00:00:00.000Z", "f".repeat(32))).toBe(false);
    const [stored] = await webhooks.list(USER);
    expect(stored!.cursor).toBe(`2030-01-01T00:00:00.000Z|${"b".repeat(32)}`);
  });
});

describe("the dashboard's example delivery", () => {
  useKeyedStore();
  it("has the headers and body fields a real signed delivery has", async () => {
    await webhooks.create(USER, {
      url: "https://example.test/hook",
      events: ["*"],
      secret: "s3cret-s3cret",
      authHeader: { name: "Authorization", value: "Bearer example-credential-1234" },
    });
    nowMs += 1000;
    await events.append(USER, { type: "presence.entered_place", placeName: "home", status: "home", source: "owntracks" });
    let sent: { headers: Headers; body: string } | undefined;
    const fetchFn = vi.fn(async (_url: string, init: any) => {
      sent = { headers: init.headers, body: init.body };
      return new Response(null, { status: 200 });
    });
    await makeDispatcher({ fetchFn: fetchFn as any }).tick();
    const example = exampleDelivery("presence.entered_place", {
      signed: true,
      authHeader: { name: "Authorization", hint: "…1234" },
    });
    expect(Object.keys(example.headers).map((k) => k.toLowerCase()).sort()).toEqual([...sent!.headers.keys()].sort());
    expect(example.headers["Authorization"]).toBe("••••••••1234");
    expect(Object.keys(example.body).sort()).toEqual(Object.keys(JSON.parse(sent!.body)).sort());
    expect(Object.keys(exampleDelivery("presence.updated", { signed: false }).headers)).not.toContain("x-wherectx-signature");
  });
});

describe("WebhookDispatcher auth header", () => {
  useKeyedStore();
  const VALUE = "Bearer n8n-header-credential-9f3k";
  const authHeader = { name: "Authorization", value: VALUE };

  async function capture(fetchImpl: (url: string, init: any) => Promise<Response>, over: Partial<DispatcherOptions> = {}) {
    const sent: Array<{ url: string; init: any }> = [];
    const fetchFn = vi.fn(async (url: string, init: any) => {
      sent.push({ url, init });
      return fetchImpl(url, init);
    });
    await makeDispatcher({ fetchFn: fetchFn as any, ...over }).tick();
    return sent;
  }

  it("is sent on every delivery to its own hook, beside the signature, and to no other hook", async () => {
    const secret = "shhh-very-secret-value";
    await webhooks.create(USER, { url: "https://example.test/with", events: ["*"], secret, authHeader });
    await webhooks.create(USER, { url: "https://example.test/without", events: ["*"] });
    nowMs += 1000;
    await events.append(USER, { type: "presence.updated", status: "home" });
    nowMs += 1;
    await events.append(USER, { type: "presence.left_place", placeName: "home" });

    const sent = await capture(async () => new Response(null, { status: 200 }));
    const to = (url: string) => sent.filter((s) => s.url === url);
    expect(to("https://example.test/with")).toHaveLength(2);
    for (const { init } of to("https://example.test/with")) {
      expect(init.headers.get("Authorization")).toBe(VALUE);
      const sig = createHmac("sha256", secret).update(`${init.headers.get("x-wherectx-timestamp")}.${init.body}`).digest("hex");
      expect(init.headers.get("x-wherectx-signature")).toBe(`sha256=${sig}`);
    }
    expect(to("https://example.test/without")).toHaveLength(2);
    for (const { init } of to("https://example.test/without")) {
      expect([...init.headers.keys()]).not.toContain("authorization");
      expect(JSON.stringify([...init.headers])).not.toContain(VALUE);
    }
  });

  it("is sealed at rest and still sent in the clear to the receiver", async () => {
    const { SecretBox } = await import("./secretBox.js");
    const store = new WebhooksStore(handle.db, clock, new SecretBox("install-key"));
    await store.create(USER, { url: "https://example.test/hook", events: ["*"], authHeader: { name: "X-Api-Key", value: "key-0123456789" } });
    nowMs += 1000;
    await events.append(USER, { type: "presence.updated", status: "home" });
    const sent = await capture(async () => new Response(null, { status: 200 }), { webhooksStore: store });
    expect(sent[0]!.init.headers.get("X-Api-Key")).toBe("key-0123456789");
  });

  it("is sent only to an https URL unless private targets are allowed", async () => {
    await webhooks.create(USER, { url: "http://example.test/plain", events: ["*"], authHeader });
    await webhooks.create(USER, { url: "https://example.test/tls", events: ["*"], authHeader });
    nowMs += 1000;
    await events.append(USER, { type: "presence.updated", status: "home" });
    const sent = await capture(async () => new Response(null, { status: 200 }), { maxAttempts: 1 });
    expect(sent.map((s) => s.url)).toEqual(["https://example.test/tls"]);
    expect((await webhooks.listDeadLetters(USER)).map((d) => d.error)).toEqual(["auth header needs an https URL"]);
  });

  it("is sent over http when private targets are allowed", async () => {
    await webhooks.create(USER, { url: "http://example.test/plain", events: ["*"], authHeader });
    nowMs += 1000;
    await events.append(USER, { type: "presence.updated", status: "home" });
    const sent = await capture(async () => new Response(null, { status: 200 }), { allowPrivateTargets: true });
    expect(sent.map((s) => s.init.headers.get("authorization"))).toEqual([VALUE]);
  });

  it("never reaches a log line or a dead letter when a delivery fails quoting it", async () => {
    const { clearLogs, recentLogs } = await import("../util/log.js");
    clearLogs();
    const written: string[] = [];
    const spies = [process.stdout, process.stderr].map((stream) =>
      vi.spyOn(stream, "write").mockImplementation((chunk: any) => {
        written.push(String(chunk));
        return true;
      }),
    );
    try {
      await webhooks.create(USER, { url: "https://example.test/hook", events: ["*"], authHeader: { name: "X-Api-Key", value: "plain-api-key-77aa" } });
      await webhooks.create(USER, { url: "https://example.test/bearer", events: ["*"], authHeader });
      nowMs += 1000;
      await events.append(USER, { type: "presence.updated", status: "home" });
      await capture(
        async (_url, init) => {
          const [name, value] = [...(init.headers as Headers)].find(([k]) => k === "x-api-key" || k === "authorization")!;
          throw new TypeError(`Headers.append: "${name}: ${value}" is an invalid header value.`);
        },
        { maxAttempts: 1 },
      );
      const dead = await webhooks.listDeadLetters(USER);
      expect(dead).toHaveLength(2);
      const everywhere = [JSON.stringify(dead), JSON.stringify(recentLogs()), written.join("")].join("\n");
      expect(everywhere).toContain("invalid header value");
      for (const leaked of ["plain-api-key", "api-key-77aa", "n8n-header-credential", "credential-9f3k"]) {
        expect(everywhere).not.toContain(leaked);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
