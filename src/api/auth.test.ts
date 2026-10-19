import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createAppContext, type AppContext } from "../app/context.js";
import { buildApp } from "../app/server.js";
import { RateLimiter } from "./rateLimit.js";
import {
  Browser,
  FakeCeremony,
  authenticator,
  login,
  setupOwner,
  testConfig,
  type Enrolled,
} from "../testing/accounts.js";
import type { WhereCtxConfig } from "../config.js";

const DAY = 24 * 3600_000;
const OWNER_ADMIN = "owner-admin-token-strong-0123456789abcdef";

let now: number;
const opened: AppContext[] = [];

async function boot(overrides: Partial<WhereCtxConfig> = {}, limiter?: RateLimiter) {
  const { ctx, bootstrap } = await createAppContext(
    testConfig({ bootstrapTokens: { admin: OWNER_ADMIN }, ...overrides }),
    { clock: () => new Date(now), ceremony: new FakeCeremony() },
  );
  opened.push(ctx);
  const app = buildApp(ctx, { authLimiter: limiter });
  return { ctx, app, setupCode: bootstrap.setupCode?.reveal() as string };
}

beforeEach(() => {
  now = Date.parse("2026-10-18T00:00:00.000Z");
});

afterEach(() => {
  for (const ctx of opened.splice(0)) ctx.handle.client.close();
});

describe("first-owner setup", () => {
  it("requires the boot setup code and closes once a passkey exists", async () => {
    const { app, setupCode } = await boot();
    expect(setupCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const wrong = await new Browser(app).send("/v1/auth/setup/options", { body: { code: "AAAA-BBBB-CCCC" } });
    expect(wrong.status).toBe(401);

    const owner = await setupOwner(app, setupCode.toLowerCase().replace(/-/g, " "));
    expect(owner.userId).toBe("owner");
    expect(owner.recoveryCodes).toHaveLength(8);
    expect(new Set(owner.recoveryCodes).size).toBe(8);

    const again = await new Browser(app).send("/v1/auth/setup/options", { body: { code: setupCode } });
    expect(again.status).toBe(410);

    const me = await owner.browser.json("/v1/me");
    expect(me.user.id).toBe("owner");
    expect(me.workspaces).toEqual([expect.objectContaining({ name: "Default", role: "owner" })]);
    expect(me.passkeys).toHaveLength(1);
  });

  it("does not mint a setup code once a passkey is registered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wherectx-setup-"));
    try {
      const databaseUrl = `file:${join(dir, "db.sqlite")}`;
      const first = await boot({ databaseUrl });
      await setupOwner(first.app, first.setupCode);
      const second = await boot({ databaseUrl });
      expect(second.setupCode).toBeUndefined();
      const workspaces = await second.ctx.system.workspaces.listForUser(second.ctx.config.defaultUserId);
      expect(workspaces).toHaveLength(1);
    } finally {
      for (const ctx of opened.splice(0)) ctx.handle.client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts wrong setup codes toward the auth-failure limiter", async () => {
    const limiter = new RateLimiter({ max: 3 });
    const { app, setupCode } = await boot({}, limiter);
    const browser = new Browser(app);
    for (let i = 0; i < 3; i++) {
      expect((await browser.send("/v1/auth/setup/options", { body: { code: "WRONG" } })).status).toBe(401);
    }
    const blocked = await browser.send("/v1/auth/setup/options", { body: { code: setupCode } });
    expect(blocked.status).toBe(429);
  });
});

describe("login and the session cookie", () => {
  let app: Hono;
  let owner: Enrolled;

  beforeEach(async () => {
    const booted = await boot();
    app = booted.app;
    owner = await setupOwner(app, booted.setupCode);
  });

  it("sets an HttpOnly, SameSite=Lax, 30-day cookie without Secure on http", async () => {
    const browser = await login(app, owner.credentialId);
    const cookie = browser.lastSetCookie!;
    expect(cookie).toMatch(/^wctx_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; SameSite=Lax/);
    expect(cookie).toMatch(/; Path=\//);
    expect(cookie).toMatch(/; Max-Age=2592000/);
    expect(cookie).not.toMatch(/Secure/);
  });

  it("marks the cookie Secure when BASE_URL is https", async () => {
    const booted = await boot({ baseUrl: "https://where.example.com" });
    const enrolled = await new Browser(booted.app).send("/v1/auth/setup/options", {
      body: { code: booted.setupCode },
      origin: "https://where.example.com",
    });
    const start = (await enrolled.json()) as any;
    const res = await booted.app.request("/v1/auth/setup/verify", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://where.example.com" },
      body: JSON.stringify({
        code: booted.setupCode,
        ceremony: start.ceremony,
        response: authenticator.create(start.options),
      }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("set-cookie")).toMatch(/; Secure/);
  });

  it("rejects an assertion that does not match the stored passkey", async () => {
    const browser = new Browser(app);
    const start = await browser.json("/v1/auth/login/options", { body: {} });
    const forged = authenticator.get(start.options, owner.credentialId);
    forged.response.signature = "Zm9yZ2Vk";
    const res = await browser.send("/v1/auth/login/verify", {
      body: { ceremony: start.ceremony, response: forged },
    });
    expect(res.status).toBe(401);
    expect(browser.cookie).toBeUndefined();
  });

  it("does not accept a login ceremony twice", async () => {
    const browser = new Browser(app);
    const start = await browser.json("/v1/auth/login/options", { body: {} });
    const body = {
      ceremony: start.ceremony,
      response: authenticator.get(start.options, owner.credentialId),
    };
    expect((await browser.send("/v1/auth/login/verify", { body })).status).toBe(200);
    expect((await browser.send("/v1/auth/login/verify", { body })).status).toBe(401);
  });

  it("reaches the existing API as the session's user", async () => {
    const browser = await login(app, owner.credentialId);
    const ingest = await browser.send("/v1/ingest", { body: { lat: 37.5, lon: 127.0 } });
    expect(ingest.status).toBe(200);

    const presence = await browser.json("/v1/presence");
    expect(presence.status).toBeDefined();
    const viaToken = await app.request("/v1/presence", {
      headers: { authorization: `Bearer ${OWNER_ADMIN}` },
    });
    expect(await viaToken.json()).toEqual(presence);
  });

  it("rejects requests without a credential", async () => {
    expect((await new Browser(app).send("/v1/presence")).status).toBe(401);
  });

  it("expires a session 30 days after its last refresh, sliding on use", async () => {
    const browser = await login(app, owner.credentialId);
    now += 2 * DAY;
    expect((await browser.send("/v1/presence/history")).status).toBe(200);
    expect(browser.lastSetCookie).toMatch(/Max-Age=2592000/);
    now += 29 * DAY;
    expect((await browser.send("/v1/presence/history")).status).toBe(200);
    now += 31 * DAY;
    expect((await browser.send("/v1/presence/history")).status).toBe(401);
  });

  it("rejects a session after it is revoked or logged out", async () => {
    const kept = await login(app, owner.credentialId);
    const revoked = await login(app, owner.credentialId);
    const target = (await revoked.json("/v1/me")).sessions.find((s: any) => s.current);
    expect((await kept.json("/v1/me")).sessions.map((s: any) => s.id)).toContain(target.id);
    await kept.json(`/v1/me/sessions/${target.id}`, { method: "DELETE" });
    expect((await revoked.send("/v1/me")).status).toBe(401);
    expect((await kept.send("/v1/me")).status).toBe(200);

    const stolen = kept.cookie;
    await kept.json("/v1/auth/logout", { body: {} });
    expect(kept.cookie).toBeUndefined();
    kept.cookie = stolen;
    expect((await kept.send("/v1/me")).status).toBe(401);
  });
});

describe("CSRF on cookie-authenticated writes", () => {
  let app: Hono;
  let browser: Browser;

  beforeEach(async () => {
    const booted = await boot();
    app = booted.app;
    browser = (await setupOwner(app, booted.setupCode)).browser;
  });

  const point = { lat: 37.5, lon: 127.0 };

  it("refuses a session POST with no Origin", async () => {
    expect((await browser.send("/v1/ingest", { body: point, origin: null })).status).toBe(403);
  });

  it("refuses a session POST from another origin", async () => {
    const res = await browser.send("/v1/ingest", { body: point, origin: "https://evil.example" });
    expect(res.status).toBe(403);
    const created = await browser.send("/v1/workspaces", {
      body: { name: "x" },
      origin: "https://evil.example",
    });
    expect(created.status).toBe(403);
  });

  it("accepts a session POST from the server's own origin", async () => {
    expect((await browser.send("/v1/ingest", { body: point })).status).toBe(200);
  });

  it("allows a session GET without an Origin", async () => {
    expect((await browser.send("/v1/me", { origin: null })).status).toBe(200);
  });

  it("does not apply to Bearer requests, which win over a cookie", async () => {
    // The cookie alone would be accepted here; the admin token lacks
    // write_location, so a 403 shows the token was the credential used.
    expect((await browser.send("/v1/ingest", { body: point })).status).toBe(200);
    const res = await browser.send("/v1/ingest", { body: point, bearer: OWNER_ADMIN });
    expect(res.status).toBe(403);
    const device = await app.request("/v1/tokens", {
      method: "POST",
      headers: { authorization: `Bearer ${OWNER_ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "phone", role: "device" }),
    });
    const { secret } = (await device.json()) as any;
    const ingest = await app.request("/v1/ingest", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify(point),
    });
    expect(ingest.status).toBe(200);
  });
});

describe("account security", () => {
  let app: Hono;
  let owner: Enrolled;

  beforeEach(async () => {
    const booted = await boot();
    app = booted.app;
    owner = await setupOwner(app, booted.setupCode);
  });

  it("signs in with a recovery code exactly once", async () => {
    const [code] = owner.recoveryCodes;
    const browser = new Browser(app);
    const first = await browser.json("/v1/auth/recover", { body: { code } });
    expect(first).toEqual({ userId: "owner", registerPasskey: true });
    expect((await browser.json("/v1/me")).user.id).toBe("owner");

    const reuse = await new Browser(app).send("/v1/auth/recover", { body: { code } });
    expect(reuse.status).toBe(401);
  });

  it("replaces every recovery code on regeneration", async () => {
    const { recoveryCodes } = await owner.browser.json("/v1/me/recovery-codes", { body: {} });
    expect(recoveryCodes).toHaveLength(8);
    const old = await new Browser(app).send("/v1/auth/recover", { body: { code: owner.recoveryCodes[1] } });
    expect(old.status).toBe(401);
    expect((await new Browser(app).send("/v1/auth/recover", { body: { code: recoveryCodes[0] } })).status).toBe(200);
  });

  it("never deletes the last passkey", async () => {
    const res = await owner.browser.send(`/v1/me/passkeys/${owner.credentialId}`, { method: "DELETE" });
    expect(res.status).toBe(409);

    const start = await owner.browser.json("/v1/me/passkeys/options", { body: {} });
    expect(start.options.excludeCredentials).toEqual([
      expect.objectContaining({ id: owner.credentialId }),
    ]);
    const response = authenticator.create(start.options);
    const added = await owner.browser.json("/v1/me/passkeys/verify", {
      body: { ceremony: start.ceremony, response, name: "Laptop" },
    });
    expect(added.passkey).toMatchObject({ id: response.id, name: "Laptop" });

    const removed = await owner.browser.send(`/v1/me/passkeys/${owner.credentialId}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect((await owner.browser.json("/v1/me")).passkeys.map((p: any) => p.id)).toEqual([response.id]);
    expect((await login(app, response.id)).cookie).toBeDefined();
  });

  it("keeps account routes away from tokens", async () => {
    const res = await app.request("/v1/me", { headers: { authorization: `Bearer ${OWNER_ADMIN}` } });
    expect(res.status).toBe(403);
  });

  it("renames the user", async () => {
    await owner.browser.json("/v1/me", { method: "PATCH", body: { displayName: "Jin" } });
    expect((await owner.browser.json("/v1/me")).user.displayName).toBe("Jin");
  });

  it("refuses auth POSTs from another origin", async () => {
    const res = await new Browser(app).send("/v1/auth/recover", {
      body: { code: owner.recoveryCodes[0] },
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
  });
});
