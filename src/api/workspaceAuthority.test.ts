import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { AppContext } from "../app/context.js";
import { asWorkspaceId, type WorkspaceId } from "../accounts/types.js";
import { MAX_PENDING_INVITES } from "../accounts/invitesStore.js";
import { MAX_WORKSPACES } from "../accounts/workspacesStore.js";
import { asUserId, type UserId } from "../types.js";
import {
  Browser,
  TestClock,
  authenticator,
  bootApp,
  inviteToken,
  setupOwner,
  signUpByInvite,
} from "../testing/accounts.js";
import type { WhereCtxConfig } from "../config.js";

let ctx: AppContext;
let app: Hono;
let owner: Browser;
let ws: WorkspaceId;

async function boot(overrides: Partial<WhereCtxConfig> = {}) {
  const booted = await bootApp(new TestClock(), overrides);
  ({ ctx, app } = booted);
  owner = (await setupOwner(app, booted.setupCode)).browser;
  ws = asWorkspaceId((await owner.json("/v1/workspaces")).workspaces[0].id);
}

async function inviteUrl(browser: Browser, role: string, workspace: string = ws): Promise<string> {
  return (await browser.json(`/v1/workspaces/${workspace}/invites`, { body: { role } })).url;
}

async function join(role: string, name: string): Promise<{ browser: Browser; userId: UserId }> {
  const { browser, res } = await signUpByInvite(app, await inviteUrl(owner, role), name);
  expect(res.status).toBe(201);
  return { browser, userId: asUserId(((await res.json()) as any).userId) };
}

const preview = (url: string) =>
  new Browser(app).send("/v1/auth/invite/preview", { body: { token: inviteToken(url) } });

afterEach(() => ctx.handle.client.close());

describe("invites follow their creator's current authority", () => {
  beforeEach(() => boot());

  it("drops a removed owner's stashed owner invite", async () => {
    const second = await join("owner", "Second");
    const stashed = await inviteUrl(second.browser, "owner");
    await owner.json(`/v1/workspaces/${ws}/members/${second.userId}`, { method: "DELETE" });
    expect((await preview(stashed)).status).toBe(401);
    expect((await signUpByInvite(app, stashed, "Mallory")).res.status).toBe(401);
  });

  it("drops a demoted admin's pending invite", async () => {
    const admin = await join("admin", "Admin");
    const adminInvite = await inviteUrl(admin.browser, "admin");
    await owner.json(`/v1/workspaces/${ws}/members/${admin.userId}`, {
      method: "PATCH",
      body: { role: "member" },
    });
    expect((await signUpByInvite(app, adminInvite, "Late")).res.status).toBe(401);
  });

  it("keeps the invites a demoted owner may still issue as an admin", async () => {
    const second = await join("owner", "Second");
    const ownerInvite = await inviteUrl(second.browser, "owner");
    const memberInvite = await inviteUrl(second.browser, "member");
    await owner.json(`/v1/workspaces/${ws}/members/${second.userId}`, {
      method: "PATCH",
      body: { role: "admin" },
    });
    expect((await preview(ownerInvite)).status).toBe(401);
    expect((await preview(memberInvite)).status).toBe(200);
  });

  it("refuses the claim itself when the creator lost authority mid-sign-up", async () => {
    const admin = await join("admin", "Admin");
    const token = inviteToken(await inviteUrl(admin.browser, "member"));
    const browser = new Browser(app);
    const start = await browser.json("/v1/auth/invite/options", { body: { token, displayName: "Late" } });
    // Demote without the store's invite cleanup, so only the claim's own guard stands.
    await ctx.handle.client.execute({
      sql: "UPDATE memberships SET role = 'member' WHERE user_id = ?",
      args: [admin.userId],
    });
    const res = await browser.send("/v1/auth/invite/verify", {
      body: { token, ceremony: start.ceremony, response: authenticator.create(start.options) },
    });
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ error: "invite revoked" });
    const users = await ctx.handle.client.execute("SELECT count(*) AS c FROM users");
    expect(Number(users.rows[0]!.c)).toBe(2);
    expect((await new Browser(app).send("/v1/auth/invite/preview", { body: { token } })).status).toBe(410);
  });

  it("answers 401 for an unknown token and 409 for someone already in the workspace", async () => {
    const unknown = await owner.send("/v1/workspaces/invites/accept", { body: { token: "x".repeat(43) } });
    expect(unknown.status).toBe(401);
    const url = await inviteUrl(owner, "member");
    const mine = await owner.send("/v1/workspaces/invites/accept", { body: { token: inviteToken(url) } });
    expect(mine.status).toBe(409);
    expect(await mine.json()).toMatchObject({ error: "you are already a member of this workspace" });
  });
});

describe("role writes re-check authority in SQL", () => {
  beforeEach(() => boot());

  it("refuses an admin acting on an owner, even when the service is bypassed", async () => {
    const admin = await join("admin", "Admin");
    const store = ctx.system.workspaces;
    const ownerId = asUserId("owner");
    expect(await store.setRole(ws, admin.userId, ownerId, "member")).toBe("forbidden");
    expect(await store.remove(ws, admin.userId, ownerId)).toBe("forbidden");
    expect(await store.roleOf(ws, ownerId)).toBe("owner");
  });

  it("refuses an admin's write on a member who became an owner after the admin looked", async () => {
    const admin = await join("admin", "Admin");
    const member = await join("member", "Member");
    expect(await ctx.system.workspaces.roleOf(ws, member.userId)).toBe("member");
    await owner.json(`/v1/workspaces/${ws}/members/${member.userId}`, { method: "PATCH", body: { role: "owner" } });
    expect(await ctx.system.workspaces.setRole(ws, admin.userId, member.userId, "member")).toBe("forbidden");
    expect(await ctx.system.workspaces.remove(ws, admin.userId, member.userId)).toBe("forbidden");
    expect(await ctx.system.workspaces.roleOf(ws, member.userId)).toBe("owner");
  });

  it("refuses an actor whose own role was lowered after the check", async () => {
    const admin = await join("admin", "Admin");
    const member = await join("member", "Member");
    await owner.json(`/v1/workspaces/${ws}/members/${admin.userId}`, { method: "PATCH", body: { role: "member" } });
    expect(await ctx.system.workspaces.remove(ws, admin.userId, member.userId)).toBe("forbidden");
    expect(await ctx.system.workspaces.roleOf(ws, member.userId)).toBe("member");
  });
});

describe("caps and creation rules", () => {
  it("caps pending invites per workspace", async () => {
    await boot();
    for (let i = 0; i < MAX_PENDING_INVITES; i++) await inviteUrl(owner, "member");
    const over = await owner.send(`/v1/workspaces/${ws}/invites`, { body: { role: "member" } });
    expect(over.status).toBe(409);
  });

  it("caps workspaces per user", async () => {
    await boot();
    for (let i = 1; i < MAX_WORKSPACES; i++) await owner.json("/v1/workspaces", { body: { name: `W${i}` } });
    expect((await owner.send("/v1/workspaces", { body: { name: "over" } })).status).toBe(409);
  });

  it("with ALLOW_MEMBER_WORKSPACES=false, lets only owners and admins create workspaces", async () => {
    await boot({ allowMemberWorkspaces: false });
    const member = await join("member", "Member");
    const admin = await join("admin", "Admin");
    expect((await member.browser.send("/v1/workspaces", { body: { name: "Mine" } })).status).toBe(403);
    expect((await admin.browser.send("/v1/workspaces", { body: { name: "Team" } })).status).toBe(201);
    expect((await owner.send("/v1/workspaces", { body: { name: "Second" } })).status).toBe(201);
  });
});
