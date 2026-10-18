import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createAppContext, type AppContext } from "../app/context.js";
import { buildApp } from "../app/server.js";
import {
  Browser,
  FakeCeremony,
  authenticator,
  inviteToken,
  setupOwner,
  signUpByInvite,
  testConfig,
} from "../testing/accounts.js";

const DAY = 24 * 3600_000;
const OWNER_ADMIN = "owner-admin-token-strong-0123456789abcdef";

let now: number;
let ctx: AppContext;
let app: Hono;
let owner: Browser;
let defaultWs: string;

async function invite(browser: Browser, workspaceId: string, role: string): Promise<string> {
  const created = await browser.json(`/v1/workspaces/${workspaceId}/invites`, { body: { role } });
  expect(created.url).toMatch(/^http:\/\/localhost:8787\/dashboard\/#invite=[A-Za-z0-9_-]{43}$/);
  return created.url;
}

async function join(role: string, name: string): Promise<{ browser: Browser; userId: string }> {
  const { browser, res } = await signUpByInvite(app, await invite(owner, defaultWs, role), name);
  expect(res.status).toBe(201);
  return { browser, userId: ((await res.json()) as any).userId };
}

beforeEach(async () => {
  now = Date.parse("2026-10-18T00:00:00.000Z");
  const built = await createAppContext(testConfig({ bootstrapTokens: { admin: OWNER_ADMIN } }), {
    clock: () => new Date(now),
    ceremony: new FakeCeremony(),
  });
  ctx = built.ctx;
  app = buildApp(ctx);
  owner = (await setupOwner(app, built.bootstrap.setupCode!.reveal())).browser;
  defaultWs = (await owner.json("/v1/workspaces")).workspaces[0].id;
});

afterEach(() => {
  ctx.handle.client.close();
});

describe("invites", () => {
  it("joins the invited workspace with the invited role", async () => {
    const url = await invite(owner, defaultWs, "admin");
    const preview = await new Browser(app).json("/v1/auth/invite/preview", { body: { token: inviteToken(url) } });
    expect(preview).toEqual({ workspaceName: "Default", role: "admin", expiresAt: expect.any(String) });

    const { browser, res } = await signUpByInvite(app, url, "Mina");
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.workspace).toMatchObject({ id: defaultWs, name: "Default", role: "admin" });
    expect(body.recoveryCodes).toHaveLength(8);

    expect((await browser.json("/v1/workspaces")).workspaces).toEqual([
      expect.objectContaining({ id: defaultWs, role: "admin" }),
    ]);
    const { members } = await owner.json(`/v1/workspaces/${defaultWs}/members`);
    expect(members).toHaveLength(2);
    expect(members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: "owner", role: "owner" }),
        expect.objectContaining({ userId: body.userId, displayName: "Mina", role: "admin" }),
      ]),
    );
    expect((await owner.json(`/v1/workspaces/${defaultWs}/invites`)).invites).toEqual([]);
  });

  it("keeps the new member out of the inviter's location data", async () => {
    await owner.json("/v1/ingest", { body: { lat: 37.5, lon: 127.0 } });
    await owner.json("/v1/places", { body: { name: "home", lat: 37.5, lon: 127.0, type: "home" } });
    const { browser } = await join("member", "Mina");

    expect((await owner.send("/v1/presence")).status).toBe(200);
    expect((await browser.send("/v1/presence")).status).toBe(404);
    expect((await browser.json("/v1/places")).places).toEqual([]);
    expect((await browser.json("/v1/events")).events).toEqual([]);
  });

  it("is single-use", async () => {
    const url = await invite(owner, defaultWs, "member");
    expect((await signUpByInvite(app, url, "First")).res.status).toBe(201);
    expect((await signUpByInvite(app, url, "Second")).res.status).toBe(410);
    expect((await new Browser(app).send("/v1/auth/invite/preview", { body: { token: inviteToken(url) } })).status).toBe(410);
  });

  it("cannot be redeemed twice even when both sign-ups are mid-ceremony", async () => {
    const url = await invite(owner, defaultWs, "member");
    const token = inviteToken(url);
    const starts = await Promise.all(
      ["A", "B"].map(async (displayName) => {
        const browser = new Browser(app);
        const start = await browser.json("/v1/auth/invite/options", { body: { token, displayName } });
        return { browser, start };
      }),
    );
    const results = await Promise.all(
      starts.map(({ browser, start }) =>
        browser.send("/v1/auth/invite/verify", {
          body: { token, ceremony: start.ceremony, response: authenticator.create(start.options) },
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 410]);
    const { members } = await owner.json(`/v1/workspaces/${defaultWs}/members`);
    expect(members).toHaveLength(2);
    const users = await ctx.handle.client.execute("SELECT count(*) AS c FROM users");
    expect(users.rows[0]!.c).toBe(2);
  });

  it("expires after seven days", async () => {
    const url = await invite(owner, defaultWs, "member");
    now += 7 * DAY + 1000;
    expect((await signUpByInvite(app, url, "Late")).res.status).toBe(410);
  });

  it("expires even while a sign-up ceremony is in progress", async () => {
    const token = inviteToken(await invite(owner, defaultWs, "member"));
    now += 7 * DAY - 60_000;
    const browser = new Browser(app);
    const start = await browser.json("/v1/auth/invite/options", { body: { token, displayName: "Slow" } });
    now += 2 * 60_000;
    const res = await browser.send("/v1/auth/invite/verify", {
      body: { token, ceremony: start.ceremony, response: authenticator.create(start.options) },
    });
    expect(res.status).toBe(410);
    expect(browser.cookie).toBeUndefined();
  });

  it("stops working once revoked", async () => {
    const created = await owner.json(`/v1/workspaces/${defaultWs}/invites`, { body: { role: "member" } });
    await owner.json(`/v1/workspaces/${defaultWs}/invites/${created.invite.id}`, { method: "DELETE" });
    expect((await signUpByInvite(app, created.url, "Revoked")).res.status).toBe(401);
    const preview = await new Browser(app).send("/v1/auth/invite/preview", {
      body: { token: inviteToken(created.url) },
    });
    expect(preview.status).toBe(401);
  });

  it("lets a signed-in user join a second workspace", async () => {
    const { browser: other } = await join("member", "Other");
    const { workspace } = await other.json("/v1/workspaces", { body: { name: "Family" } });
    expect(workspace.role).toBe("owner");
    const url = await invite(other, workspace.id, "member");

    const accepted = await owner.json("/v1/workspaces/invites/accept", { body: { token: inviteToken(url) } });
    expect(accepted.workspace).toMatchObject({ id: workspace.id, name: "Family", role: "member" });
    const mine = (await owner.json("/v1/workspaces")).workspaces;
    expect(mine.map((w: any) => [w.id, w.role]).sort()).toEqual(
      [
        [defaultWs, "owner"],
        [workspace.id, "member"],
      ].sort(),
    );
    const again = await owner.send("/v1/workspaces/invites/accept", { body: { token: inviteToken(url) } });
    expect(again.status).toBe(410);
  });
});

describe("roles", () => {
  let admin: { browser: Browser; userId: string };
  let member: { browser: Browser; userId: string };

  beforeEach(async () => {
    admin = await join("admin", "Admin");
    member = await join("member", "Member");
  });

  const members = (ws: string) => `/v1/workspaces/${ws}/members`;

  it("stops an admin from creating or touching owners", async () => {
    const promote = await admin.browser.send(`${members(defaultWs)}/${member.userId}`, {
      method: "PATCH",
      body: { role: "owner" },
    });
    expect(promote.status).toBe(403);
    const demoteOwner = await admin.browser.send(`${members(defaultWs)}/owner`, {
      method: "PATCH",
      body: { role: "member" },
    });
    expect(demoteOwner.status).toBe(403);
    expect((await admin.browser.send(`${members(defaultWs)}/owner`, { method: "DELETE" })).status).toBe(403);
    const ownerInvite = await admin.browser.send(`/v1/workspaces/${defaultWs}/invites`, {
      body: { role: "owner" },
    });
    expect(ownerInvite.status).toBe(403);

    const toAdmin = await admin.browser.send(`${members(defaultWs)}/${member.userId}`, {
      method: "PATCH",
      body: { role: "admin" },
    });
    expect(toAdmin.status).toBe(200);
    expect((await admin.browser.send(`/v1/workspaces/${defaultWs}/invites`, { body: { role: "member" } })).status).toBe(201);
  });

  it("stops a member from inviting, changing roles, or removing others", async () => {
    const res = await member.browser.send(`/v1/workspaces/${defaultWs}/invites`, { body: { role: "member" } });
    expect(res.status).toBe(403);
    const role = await member.browser.send(`${members(defaultWs)}/${admin.userId}`, {
      method: "PATCH",
      body: { role: "member" },
    });
    expect(role.status).toBe(403);
    expect((await member.browser.send(`${members(defaultWs)}/${admin.userId}`, { method: "DELETE" })).status).toBe(403);
    expect((await member.browser.send(`${members(defaultWs)}/${member.userId}`, { method: "DELETE" })).status).toBe(200);
    expect((await member.browser.json("/v1/workspaces")).workspaces).toEqual([]);
  });

  it("never leaves a workspace without an owner", async () => {
    expect((await owner.send(`${members(defaultWs)}/owner`, { method: "DELETE" })).status).toBe(409);
    const demote = await owner.send(`${members(defaultWs)}/owner`, { method: "PATCH", body: { role: "admin" } });
    expect(demote.status).toBe(409);

    await owner.json(`${members(defaultWs)}/${admin.userId}`, { method: "PATCH", body: { role: "owner" } });
    expect((await owner.send(`${members(defaultWs)}/owner`, { method: "DELETE" })).status).toBe(200);

    const last = admin.browser;
    expect((await last.send(`${members(defaultWs)}/${admin.userId}`, { method: "DELETE" })).status).toBe(409);
    const selfDemote = await last.send(`${members(defaultWs)}/${admin.userId}`, {
      method: "PATCH",
      body: { role: "member" },
    });
    expect(selfDemote.status).toBe(409);
  });

  it("lets owners rename the workspace", async () => {
    await owner.json(`/v1/workspaces/${defaultWs}`, { method: "PATCH", body: { name: "Home" } });
    expect((await member.browser.json("/v1/workspaces")).workspaces[0].name).toBe("Home");
    const byMember = await member.browser.send(`/v1/workspaces/${defaultWs}`, {
      method: "PATCH",
      body: { name: "Mine" },
    });
    expect(byMember.status).toBe(403);
  });
});

describe("workspace visibility", () => {
  it("answers 404 to non-members, exactly as for a workspace that does not exist", async () => {
    const { browser: other } = await join("member", "Other");
    const { workspace } = await other.json("/v1/workspaces", { body: { name: "Private" } });

    for (const id of [workspace.id, "0".repeat(32)]) {
      expect((await owner.send(`/v1/workspaces/${id}/members`)).status).toBe(404);
      expect((await owner.send(`/v1/workspaces/${id}`, { method: "PATCH", body: { name: "x" } })).status).toBe(404);
      expect((await owner.send(`/v1/workspaces/${id}/invites`, { body: { role: "member" } })).status).toBe(404);
      expect((await owner.send(`/v1/workspaces/${id}/invites`)).status).toBe(404);
    }
    expect((await owner.json("/v1/workspaces")).workspaces.map((w: any) => w.id)).toEqual([defaultWs]);
  });

  it("gives tokens no workspace rights", async () => {
    const res = await app.request("/v1/workspaces", { headers: { authorization: `Bearer ${OWNER_ADMIN}` } });
    expect(res.status).toBe(403);
  });
});
