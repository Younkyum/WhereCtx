import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, ensureSchema, type DbHandle } from "../db/index.js";
import { EventsStore } from "../store/eventsStore.js";
import { WebhooksStore } from "../store/webhooksStore.js";
import { asUserId } from "../types.js";
import { authHeaderProblem } from "./authHeader.js";
import { WebhookDispatcher, type DispatcherOptions } from "./dispatcher.js";
import { SecretBox } from "./secretBox.js";

const USER = asUserId("default");
const VALUE = "Bearer n8n-header-credential-9f3k";
let nowMs = Date.parse("2026-06-05T00:00:00.000Z");
const clock = () => new Date(nowMs);

interface Receiver {
  port: number;
  requests: Array<{ url: string; headers: IncomingHttpHeaders; body: string }>;
}

const servers: Server[] = [];

async function receiver(respond: (res: import("node:http").ServerResponse) => void = (res) => res.end()): Promise<Receiver> {
  const requests: Receiver["requests"] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ url: req.url ?? "", headers: req.headers, body });
      respond(res);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, requests };
}

let handle: DbHandle;
let webhooks: WebhooksStore;
let events: EventsStore;

beforeEach(async () => {
  nowMs = Date.parse("2026-06-05T00:00:00.000Z");
  handle = createDb(":memory:");
  await ensureSchema(handle);
  webhooks = new WebhooksStore(handle.db, clock, new SecretBox("transport-test-key"));
  events = new EventsStore(handle.db, clock);
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

async function deliverOnce(url: string, over: Partial<DispatcherOptions>, hook: { secret?: string; auth?: boolean } = {}) {
  await webhooks.create(USER, {
    url,
    events: ["*"],
    secret: hook.secret,
    ...(hook.auth === false ? {} : { authHeader: { name: "Authorization", value: VALUE } }),
  });
  nowMs += 1000;
  await events.append(USER, { type: "presence.updated", status: "home" });
  await new WebhookDispatcher({ webhooksStore: webhooks, eventsStore: events, clock, maxAttempts: 1, ...over }).tick();
}

describe("a delivery over a real connection", () => {
  it("reaches the receiver with its headers and body", async () => {
    const r = await receiver();
    await deliverOnce(`http://127.0.0.1:${r.port}/hook`, { allowPrivateTargets: true });
    expect(r.requests).toHaveLength(1);
    const [req] = r.requests;
    expect(req!.headers["authorization"]).toBe(VALUE);
    expect(req!.headers["host"]).toBe(`127.0.0.1:${r.port}`);
    expect(req!.headers["content-length"]).toBe(String(Buffer.byteLength(req!.body)));
    expect(JSON.parse(req!.body).event).toBe("presence.updated");
  });

  it("does not follow a redirect, so the header never reaches the Location", async () => {
    const elsewhere = await receiver();
    const hook = await receiver((res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${elsewhere.port}/steal` });
      res.end();
    });
    await deliverOnce(`http://127.0.0.1:${hook.port}/hook`, { allowPrivateTargets: true });
    expect(hook.requests).toHaveLength(1);
    expect(elsewhere.requests).toEqual([]);
    expect((await webhooks.listDeadLetters(USER))[0]!.error).toBe("status 302");
  });

  it("is not sent when the name resolves publicly at the check and privately at connect", async () => {
    const r = await receiver();
    const answers: string[][] = [["93.184.216.34"], ["127.0.0.1"]];
    let lookups = 0;
    const urlResolver = async () => answers[Math.min(lookups++, answers.length - 1)]!;
    await deliverOnce(`http://rebind.test:${r.port}/hook`, { urlResolver });
    expect(lookups).toBe(2);
    expect(r.requests).toEqual([]);
    const [dead] = await webhooks.listDeadLetters(USER);
    expect(dead!.error).toContain("private/reserved address (127.0.0.1)");
  });

  it("sets no header of its own that an auth header could name", async () => {
    const r = await receiver();
    await deliverOnce(`http://127.0.0.1:${r.port}/hook`, { allowPrivateTargets: true }, { secret: "s3cret-s3cret", auth: false });
    const own = Object.keys(r.requests[0]!.headers).filter((name) => !["host", "connection", "content-length"].includes(name));
    expect(own.sort()).toEqual(["content-type", "user-agent", "x-wherectx-event", "x-wherectx-signature", "x-wherectx-timestamp"]);
    for (const name of [...own, "host", "connection", "content-length"]) {
      expect(authHeaderProblem(name, "v"), name).not.toBeNull();
    }
  });
});
