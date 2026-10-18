import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { AppContext } from "../app/context.js";
import {
  Browser,
  OWNER_ADMIN,
  PUBLIC_BASE_URL,
  TestClock,
  authenticator,
  bootApp,
  login,
  reauth,
  setupOwner,
  signUpByInvite,
  type Enrolled,
} from "../testing/accounts.js";
import { RateLimiter } from "./rateLimit.js";

const MINUTE = 60_000;
const DAY = 24 * 3600_000;

let clock: TestClock;
let ctx: AppContext;
let app: Hono;
let owner: Enrolled;

beforeEach(async () => {
  clock = new TestClock();
  const booted = await bootApp(clock);
  ({ ctx, app } = booted);
  owner = await setupOwner(app, booted.setupCode);
});

afterEach(() => ctx.handle.client.close());

async function sessionCount(): Promise<number> {
  const rows = await ctx.handle.client.execute("SELECT count(*) AS c FROM sessions");
  return Number(rows.rows[0]!.c);
}

describe("step-up re-authentication", () => {
  let minaId: string;

  /** Mina joins the owner's workspace; with `level`, the owner already shares with her. */
  async function withMina(level?: "coarse" | "precise", hideHomeExact?: boolean): Promise<void> {
    const ws = (await owner.browser.json("/v1/workspaces")).workspaces[0].id;
    const { url } = await owner.browser.json(`/v1/workspaces/${ws}/invites`, { body: { role: "member" } });
    const { res } = await signUpByInvite(app, url, "Mina", PUBLIC_BASE_URL);
    minaId = ((await res.json()) as any).userId;
    if (level) await owner.browser.json(`/v1/shares/${minaId}`, { method: "PUT", body: { level, hideHomeExact } });
  }

  beforeEach(async () => {
    // Device pairing needs a BASE_URL a phone can reach.
    ctx.handle.client.close();
    const booted = await bootApp(clock, { baseUrl: PUBLIC_BASE_URL });
    ({ ctx, app } = booted);
    owner = await setupOwner(app, booted.setupCode, PUBLIC_BASE_URL);
  });

  const sensitive: ReadonlyArray<
    readonly [string, () => Promise<unknown>, string, () => string, unknown]
  > = [
    ["add a passkey", async () => {}, "POST", () => "/v1/me/passkeys/options", {}],
    ["replace recovery codes", async () => {}, "POST", () => "/v1/me/recovery-codes", {}],
    ["mint a token", async () => {}, "POST", () => "/v1/tokens", { name: "agent", role: "agent" }],
    ["pair a device", async () => {}, "POST", () => "/v1/devices/pair", { name: "phone", kind: "owntracks" }],
    ["share my location", () => withMina(), "PUT", () => `/v1/shares/${minaId}`, { level: "coarse" }],
    ["raise a share to precise", () => withMina("coarse"), "PUT", () => `/v1/shares/${minaId}`, { level: "precise" }],
    [
      "unhide home on a share",
      () => withMina("precise", true),
      "PUT",
      () => `/v1/shares/${minaId}`,
      { level: "precise", hideHomeExact: false },
    ],
  ];

  it.each(sensitive)("is required to %s more than 10 minutes after sign-in", async (_, arrange, method, path, body) => {
    await arrange();
    clock.advance(11 * MINUTE);
    const stale = await owner.browser.send(path(), { method, body });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ code: "reauth_required" });

    await reauth(owner.browser, owner.credentialId);
    expect((await owner.browser.send(path(), { method, body })).ok).toBe(true);
  });

  it("is not required to keep, lower or revoke a share", async () => {
    await withMina("precise", false);
    clock.advance(11 * MINUTE);
    const put = (body: unknown) => owner.browser.send(`/v1/shares/${minaId}`, { method: "PUT", body });
    expect((await put({ level: "precise" })).status).toBe(200);
    expect((await put({ level: "precise", hideHomeExact: true })).status).toBe(200);
    expect((await put({ level: "coarse" })).status).toBe(200);
    expect((await put({ level: "coarse", hideHomeExact: true })).status).toBe(200);
    expect((await owner.browser.json("/v1/shares")).outgoing).toEqual([
      expect.objectContaining({ level: "coarse", hideHomeExact: true }),
    ]);
    expect((await put({ level: "precise" })).status).toBe(403);
    expect((await owner.browser.send(`/v1/shares/${minaId}`, { method: "DELETE" })).status).toBe(200);
  });

  it("is required to delete a passkey", async () => {
    const start = await owner.browser.json("/v1/me/passkeys/options", { body: {} });
    const second = authenticator.create(start.options);
    await owner.browser.json("/v1/me/passkeys/verify", { body: { ceremony: start.ceremony, response: second } });
    clock.advance(11 * MINUTE);
    const path = `/v1/me/passkeys/${owner.credentialId}`;
    expect((await owner.browser.send(path, { method: "DELETE" })).status).toBe(403);
    await reauth(owner.browser, second.id);
    expect((await owner.browser.send(path, { method: "DELETE" })).status).toBe(200);
  });

  it("does not apply to tokens, which prove themselves", async () => {
    clock.advance(11 * MINUTE);
    const res = await app.request("/v1/tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${OWNER_ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "agent", role: "agent" }),
    });
    expect(res.status).toBe(201);
  });

  it("only accepts a passkey of the signed-in user, through a ceremony bound to them", async () => {
    const workspaceId = (await owner.browser.json("/v1/workspaces")).workspaces[0].id;
    const { url } = await owner.browser.json(`/v1/workspaces/${workspaceId}/invites`, {
      body: { role: "member" },
    });
    const token = /#invite=(.+)$/.exec(url)![1]!;
    const mina = new Browser(app, PUBLIC_BASE_URL);
    const start = await mina.json("/v1/auth/invite/options", { body: { token, displayName: "Mina" } });
    const minaKey = authenticator.create(start.options);
    await mina.json("/v1/auth/invite/verify", { body: { token, ceremony: start.ceremony, response: minaKey } });

    const ownerStart = await owner.browser.json("/v1/me/reauth/options", { body: {} });
    const withMinasKey = await owner.browser.send("/v1/me/reauth/verify", {
      body: { ceremony: ownerStart.ceremony, response: authenticator.get(ownerStart.options, minaKey.id) },
    });
    expect(withMinasKey.status).toBe(401);

    const minaReauth = await mina.json("/v1/me/reauth/options", { body: {} });
    const stolenReauth = await owner.browser.send("/v1/me/reauth/verify", {
      body: { ceremony: minaReauth.ceremony, response: authenticator.get(minaReauth.options, owner.credentialId) },
    });
    expect(stolenReauth.status).toBe(401);

    const minaAdd = await mina.json("/v1/me/passkeys/options", { body: {} });
    const planted = await owner.browser.send("/v1/me/passkeys/verify", {
      body: { ceremony: minaAdd.ceremony, response: authenticator.create(minaAdd.options) },
    });
    expect(planted.status).toBe(401);
    expect((await owner.browser.json("/v1/me")).passkeys).toHaveLength(1);
  });
});

describe("session hygiene", () => {
  it("signs out every other session on request", async () => {
    const other = await login(app, owner.credentialId);
    expect(await owner.browser.json("/v1/me/sessions/revoke-others", { body: {} })).toEqual({ revoked: 1 });
    expect((await other.send("/v1/me")).status).toBe(401);
    expect((await owner.browser.send("/v1/me")).status).toBe(200);
  });

  it("ends other sessions when recovery codes are replaced or a passkey is deleted", async () => {
    let other = await login(app, owner.credentialId);
    await owner.browser.json("/v1/me/recovery-codes", { body: {} });
    expect((await other.send("/v1/me")).status).toBe(401);

    const start = await owner.browser.json("/v1/me/passkeys/options", { body: {} });
    const second = authenticator.create(start.options);
    await owner.browser.json("/v1/me/passkeys/verify", { body: { ceremony: start.ceremony, response: second } });
    other = await login(app, owner.credentialId);
    await owner.browser.json(`/v1/me/passkeys/${second.id}`, { method: "DELETE" });
    expect((await other.send("/v1/me")).status).toBe(401);
    expect((await owner.browser.send("/v1/me")).status).toBe(200);
  });

  it("replaces the session a browser already had when it signs in again", async () => {
    const before = await sessionCount();
    const oldCookie = owner.browser.cookie;
    await login(app, owner.credentialId, owner.browser);
    expect(owner.browser.cookie).not.toBe(oldCookie);
    expect(await sessionCount()).toBe(before);
    const stale = new Browser(app);
    stale.cookie = oldCookie;
    expect((await stale.send("/v1/me")).status).toBe(401);
  });

  it("ends a session 90 days after sign-in even while it is used daily", async () => {
    for (let day = 1; day < 90; day += 5) {
      clock.now = Date.parse("2026-10-18T00:00:00.000Z") + day * DAY;
      expect((await owner.browser.send("/v1/me")).status).toBe(200);
    }
    clock.now = Date.parse("2026-10-18T00:00:00.000Z") + 90 * DAY + 1000;
    expect((await owner.browser.send("/v1/me")).status).toBe(401);
  });
});

describe("recovery", () => {
  it("issues 8 codes of a public lookup id and a 24-character secret, each usable once", async () => {
    expect(owner.recoveryCodes).toHaveLength(8);
    for (const code of owner.recoveryCodes) {
      expect(code).toMatch(/^[A-Z2-9]{6}(-[A-Z2-9]{6}){4}$/);
    }
    const typed = owner.recoveryCodes[0]!.toLowerCase().replace(/-/g, " ");
    const browser = new Browser(app);
    expect(await browser.json("/v1/auth/recover", { body: { code: typed } })).toEqual({
      userId: "owner",
      registerPasskey: true,
    });
    expect((await new Browser(app).send("/v1/auth/recover", { body: { code: typed } })).status).toBe(401);
  });

  it("refuses a code whose secret part is wrong", async () => {
    const [code] = owner.recoveryCodes;
    const forged = code!.slice(0, 7) + (code![7] === "A" ? "B" : "A") + code!.slice(8);
    expect((await new Browser(app).send("/v1/auth/recover", { body: { code: forged } })).status).toBe(401);
  });

  it("signs out every other session and opens the step-up window", async () => {
    clock.advance(11 * MINUTE);
    const browser = new Browser(app);
    await browser.json("/v1/auth/recover", { body: { code: owner.recoveryCodes[0] } });
    expect((await owner.browser.send("/v1/me")).status).toBe(401);
    expect((await browser.send("/v1/me/passkeys/options", { body: {} })).status).toBe(200);
  });
});

describe("request limits on sign-in starters", () => {
  it("throttles one recovery code's lookup id after repeated failures", async () => {
    const booted = await bootApp(clock, {}, {
      authRouterLimits: {
        requests: new RateLimiter({ max: 1000 }),
        recoveryCodes: new RateLimiter({ max: 3 }),
      },
    });
    const enrolled = await setupOwner(booted.app, booted.setupCode);
    const [code] = enrolled.recoveryCodes;
    const wrong = code!.slice(0, 7) + (code![7] === "A" ? "B" : "A") + code!.slice(8);
    for (let i = 0; i < 3; i++) {
      expect((await new Browser(booted.app).send("/v1/auth/recover", { body: { code: wrong } })).status).toBe(401);
    }
    const right = await new Browser(booted.app).send("/v1/auth/recover", { body: { code } });
    expect(right.status).toBe(429);
    booted.ctx.handle.client.close();
  });

  it("counts every options request, not only failures", async () => {
    const booted = await bootApp(clock, {}, {
      authRouterLimits: { requests: new RateLimiter({ max: 2 }), recoveryCodes: new RateLimiter() },
    });
    const browser = new Browser(booted.app);
    expect((await browser.send("/v1/auth/login/options", { body: {} })).status).toBe(200);
    expect((await browser.send("/v1/auth/login/options", { body: {} })).status).toBe(200);
    expect((await browser.send("/v1/auth/login/options", { body: {} })).status).toBe(429);
    booted.ctx.handle.client.close();
  });
});
