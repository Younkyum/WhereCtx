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
  const booted = await bootApp(clock);
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

  it("sets and clears a place filter", async () => {
    const set = await patch(owner.browser, hookId, { places: ["gym", "home", "gym"] });
    expect(set.status).toBe(200);
    expect(((await set.json()) as any).webhook.places).toEqual(["gym", "home"]);
    const cleared = await patch(owner.browser, hookId, { places: null });
    expect(((await cleared.json()) as any).webhook).not.toHaveProperty("places");
    expect((await patch(owner.browser, hookId, { places: [] })).status).toBe(400);
    expect((await patch(owner.browser, hookId, { places: ["x".repeat(65)] })).status).toBe(400);
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
