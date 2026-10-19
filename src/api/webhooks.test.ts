import { beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { AppContext } from "../app/context.js";
import { Browser, TestClock, bootApp, setupOwner, signUpByInvite, type Enrolled } from "../testing/accounts.js";

let clock: TestClock;
let ctx: AppContext;
let app: Hono;
let owner: Enrolled;
let mina: Browser;
let hookId: string;

const patch = (browser: Browser, id: string, body: unknown) => browser.send(`/v1/webhooks/${id}`, { method: "PATCH", body });

async function cursorOf(id: string): Promise<string> {
  const rows = await ctx.handle.client.execute({ sql: "SELECT cursor FROM webhooks WHERE id = ?", args: [id] });
  return String(rows.rows[0]!.cursor);
}

beforeEach(async () => {
  clock = new TestClock();
  const booted = await bootApp(clock, { webhooks: { allowPrivateTargets: true, encryptionKey: "test-webhook-key" } });
  ({ ctx, app } = booted);
  owner = await setupOwner(app, booted.setupCode);
  const ws = (await owner.browser.json("/v1/workspaces")).workspaces[0].id;
  const { url } = await owner.browser.json(`/v1/workspaces/${ws}/invites`, { body: { role: "member" } });
  mina = (await signUpByInvite(app, url, "Mina")).browser;
  const created = await owner.browser.json("/v1/webhooks", {
    body: { url: "http://127.0.0.1:9/hook", events: ["presence.entered_place"] },
  });
  hookId = created.webhook.id;
});

describe("PATCH /v1/webhooks/:id", () => {
  it("changes the event selection", async () => {
    const res = await patch(owner.browser, hookId, { events: ["presence.entered_place", "presence.left_place"] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).webhook).not.toHaveProperty("secret");
    const [hook] = (await owner.browser.json("/v1/webhooks")).webhooks;
    expect(hook.events).toEqual(["presence.entered_place", "presence.left_place"]);
    expect((await patch(owner.browser, hookId, { events: ["*"] })).status).toBe(200);
  });

  it.each([
    ["an unknown event", { events: ["presence.teleported"] }],
    ["an empty selection", { events: [] }],
    ["nothing to change", {}],
    ["an unknown field", { url: "http://127.0.0.1:9/other" }],
  ])("refuses %s", async (_name, body) => {
    expect((await patch(owner.browser, hookId, body)).status).toBe(400);
  });

  it.each([
    [["presence.left_place", "presence.left_place"], ["presence.left_place"]],
    [["presence.left_place", "*", "presence.updated"], ["*"]],
    [["presence.updated", "presence.left_place", "presence.updated"], ["presence.updated", "presence.left_place"]],
  ])("stores %j as %j", async (events, stored) => {
    const res = await patch(owner.browser, hookId, { events });
    expect(((await res.json()) as any).webhook.events).toEqual(stored);
    const [hook] = (await owner.browser.json("/v1/webhooks")).webhooks;
    expect(hook.events).toEqual(stored);
  });

  it("refuses an unknown or empty event selection", async () => {
    expect((await patch(owner.browser, hookId, { events: ["presence.teleported"] })).status).toBe(400);
    expect((await patch(owner.browser, hookId, { events: [] })).status).toBe(400);
  });

  it("answers 404 for another person's hook and leaves it alone", async () => {
    expect((await patch(mina, hookId, { events: ["*"], active: false })).status).toBe(404);
    const [hook] = (await owner.browser.json("/v1/webhooks")).webhooks;
    expect(hook).toMatchObject({ events: ["presence.entered_place"], active: true });
  });

  it("pauses, and on resume skips what happened while paused", async () => {
    expect((await patch(owner.browser, hookId, { active: false })).status).toBe(200);
    const before = await cursorOf(hookId);
    clock.advance(60_000);
    expect((await patch(owner.browser, hookId, { active: true })).status).toBe(200);
    const after = await cursorOf(hookId);
    expect(after > before).toBe(true);
    expect(after.startsWith(new Date(clock.now).toISOString())).toBe(true);

    clock.advance(60_000);
    expect((await patch(owner.browser, hookId, { active: true })).status).toBe(200);
    expect(await cursorOf(hookId)).toBe(after);
  });
});

describe("a webhook's auth header over the API", () => {
  const VALUE = "Bearer n8n-header-credential-9f3k";
  const create = (browser: Browser, authHeader: unknown) =>
    browser.send("/v1/webhooks", { body: { url: "http://127.0.0.1:9/auth", events: ["*"], authHeader } });
  const listed = async (browser: Browser) => (await browser.json("/v1/webhooks")).webhooks.find((w: any) => w.url === "http://127.0.0.1:9/auth");
  async function rawRow(): Promise<string> {
    const rows = await ctx.handle.client.execute("SELECT * FROM webhooks");
    return JSON.stringify(rows.rows);
  }

  it("is shown only by name and hint, and stored sealed", async () => {
    const res = await create(owner.browser, { name: "Authorization", value: VALUE });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(JSON.parse(text).webhook.authHeader).toEqual({ name: "Authorization", hint: "…9f3k" });
    expect(text).not.toContain("credential");
    const get = await owner.browser.send("/v1/webhooks");
    const getText = await get.text();
    expect(getText).not.toContain("credential");
    expect(await listed(owner.browser)).toMatchObject({ authHeader: { name: "Authorization", hint: "…9f3k" } });
    expect(await rawRow()).not.toContain("credential");
    const [hook] = (await ctx.system.webhooks.listActive()).filter((h) => h.url === "http://127.0.0.1:9/auth");
    expect(hook!.authHeader).toEqual({ name: "Authorization", value: VALUE });
  });

  it("names the header Authorization when no name is given", async () => {
    expect((await create(owner.browser, { value: VALUE })).status).toBe(201);
    expect((await listed(owner.browser)).authHeader.name).toBe("Authorization");
  });

  it("is replaced and removed with PATCH, and never echoed", async () => {
    const id = (await (await create(owner.browser, { value: VALUE })).json() as any).webhook.id;
    const replaced = await patch(owner.browser, id, { authHeader: { name: "X-Api-Key", value: "replacement-key-0042" } });
    expect(replaced.status).toBe(200);
    const text = await replaced.text();
    expect(JSON.parse(text).webhook.authHeader).toEqual({ name: "X-Api-Key", hint: "…0042" });
    expect(text).not.toContain("replacement");
    expect((await patch(owner.browser, id, { authHeader: null })).status).toBe(200);
    expect(await listed(owner.browser)).not.toHaveProperty("authHeader");
    const [hook] = (await ctx.system.webhooks.listActive()).filter((h) => h.id === id);
    expect(hook!.authHeader).toBeUndefined();
  });

  it.each([
    ["Host", { name: "Host", value: VALUE }],
    ["Content-Length", { name: "content-length", value: VALUE }],
    ["Cookie", { name: "Cookie", value: VALUE }],
    ["a proxy header", { name: "Proxy-Authorization", value: VALUE }],
    ["the signature header", { name: "X-WhereCtx-Signature", value: VALUE }],
    ["a name with CRLF", { name: "X-A\r\nHost", value: VALUE }],
    ["a value with CRLF", { name: "Authorization", value: "Bearer n8n-header\r\nX-Evil: 1" }],
    ["an empty value", { name: "Authorization", value: "  " }],
    ["an unknown field", { name: "Authorization", value: VALUE, extra: 1 }],
  ])("refuses %s on create and on change, without echoing the value", async (_case, authHeader) => {
    const res = await create(owner.browser, authHeader);
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("n8n-header");
    const bad = await patch(owner.browser, hookId, { authHeader });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain("n8n-header");
    const hooks = (await owner.browser.json("/v1/webhooks")).webhooks;
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).not.toHaveProperty("authHeader");
  });

  it("answers 404 for another person's hook and leaves its header alone", async () => {
    const id = (await (await create(owner.browser, { value: VALUE })).json() as any).webhook.id;
    expect((await patch(mina, id, { authHeader: null })).status).toBe(404);
    expect((await patch(mina, id, { authHeader: { value: "Bearer mina-took-over-0000" } })).status).toBe(404);
    expect((await listed(owner.browser)).authHeader).toEqual({ name: "Authorization", hint: "…9f3k" });
    expect(await listed(mina)).toBeUndefined();
  });
});
