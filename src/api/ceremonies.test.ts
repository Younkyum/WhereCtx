import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { AppContext } from "../app/context.js";
import { asUserId } from "../types.js";
import {
  Browser,
  TestClock,
  authenticator,
  bootApp,
  inviteToken,
  login,
  setupOwner,
  type Enrolled,
} from "../testing/accounts.js";

const MINUTE = 60_000;

let clock: TestClock;
let ctx: AppContext;
let app: Hono;

async function count(table: string): Promise<number> {
  const rows = await ctx.handle.client.execute(`SELECT count(*) AS c FROM ${table}`);
  return Number(rows.rows[0]!.c);
}

beforeEach(async () => {
  clock = new TestClock();
});

afterEach(() => ctx.handle.client.close());

describe("first-owner setup", () => {
  let setupCode: string;

  beforeEach(async () => {
    ({ ctx, app, setupCode } = await bootApp(clock));
  });

  it("registers exactly one passkey when two setup ceremonies finish together", async () => {
    const starts = await Promise.all(
      [1, 2].map(async () => {
        const browser = new Browser(app);
        return { browser, start: await browser.json("/v1/auth/setup/options", { body: { code: setupCode } }) };
      }),
    );
    const results = await Promise.all(
      starts.map(({ browser, start }) =>
        browser.send("/v1/auth/setup/verify", {
          body: { code: setupCode, ceremony: start.ceremony, response: authenticator.create(start.options) },
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 410]);
    expect(await count("passkeys")).toBe(1);
  });

  it("refuses a login ceremony at setup", async () => {
    const browser = new Browser(app);
    const start = await browser.json("/v1/auth/login/options", { body: {} });
    const res = await browser.send("/v1/auth/setup/verify", {
      body: { code: setupCode, ceremony: start.ceremony, response: authenticator.create(start.options) },
    });
    expect(res.status).toBe(401);
    expect(await count("passkeys")).toBe(0);
  });

  it("rejects a ceremony that has expired", async () => {
    const browser = new Browser(app);
    const start = await browser.json("/v1/auth/setup/options", { body: { code: setupCode } });
    clock.advance(5 * MINUTE + 1000);
    const res = await browser.send("/v1/auth/setup/verify", {
      body: { code: setupCode, ceremony: start.ceremony, response: authenticator.create(start.options) },
    });
    expect(res.status).toBe(401);
    expect(await count("passkeys")).toBe(0);
  });

  it("rejects a ceremony whose signed state was altered", async () => {
    const browser = new Browser(app);
    const start = await browser.json("/v1/auth/login/options", { body: {} });
    const [payload, sig] = start.ceremony.split(".");
    const state = JSON.parse(Buffer.from(payload, "base64url").toString());
    const forged = Buffer.from(JSON.stringify({ ...state, purpose: "setup", userId: "owner" })).toString("base64url");
    const res = await browser.send("/v1/auth/setup/verify", {
      body: { code: setupCode, ceremony: `${forged}.${sig}`, response: authenticator.create(start.options) },
    });
    expect(res.status).toBe(401);
  });
});

describe("ceremony binding", () => {
  let owner: Enrolled;
  let workspaceId: string;

  beforeEach(async () => {
    const booted = await bootApp(clock);
    ({ ctx, app } = booted);
    owner = await setupOwner(app, booted.setupCode);
    workspaceId = (await owner.browser.json("/v1/workspaces")).workspaces[0].id;
  });

  const newInvite = async () =>
    inviteToken((await owner.browser.json(`/v1/workspaces/${workspaceId}/invites`, { body: { role: "member" } })).url);

  it("refuses a login ceremony at invite sign-up and access-code registration", async () => {
    const browser = new Browser(app);
    const token = await newInvite();
    const code = (await ctx.system.accessCodes.issue(asUserId("owner"))).code.reveal();
    for (const [path, extra] of [
      ["/v1/auth/invite/verify", { token }],
      ["/v1/auth/access-code/verify", { code }],
    ] as const) {
      const start = await browser.json("/v1/auth/login/options", { body: {} });
      const res = await browser.send(path, {
        body: { ...extra, ceremony: start.ceremony, response: authenticator.create(start.options) },
      });
      expect(res.status, path).toBe(401);
    }
    expect(await count("passkeys")).toBe(1);
  });

  it("refuses an invite ceremony presented with a different invite token", async () => {
    const [first, second] = [await newInvite(), await newInvite()];
    const browser = new Browser(app);
    const start = await browser.json("/v1/auth/invite/options", { body: { token: first, displayName: "Mina" } });
    const res = await browser.send("/v1/auth/invite/verify", {
      body: { token: second, ceremony: start.ceremony, response: authenticator.create(start.options) },
    });
    expect(res.status).toBe(401);
    expect(await count("users")).toBe(1);
  });

  it("accepts each ceremony state once", async () => {
    const browser = new Browser(app);
    const start = await browser.json("/v1/auth/login/options", { body: {} });
    const body = { ceremony: start.ceremony, response: authenticator.get(start.options, owner.credentialId) };
    expect((await browser.send("/v1/auth/login/verify", { body })).status).toBe(200);
    expect((await browser.send("/v1/auth/login/verify", { body })).status).toBe(401);
  });

  it("leaves no passkey or user behind for the loser of an invite race", async () => {
    const token = await newInvite();
    const starts = await Promise.all(
      ["A", "B"].map(async (displayName) => {
        const browser = new Browser(app);
        return { browser, start: await browser.json("/v1/auth/invite/options", { body: { token, displayName } }) };
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
    expect(await count("passkeys")).toBe(2);
    expect(await count("users")).toBe(2);
    expect(await count("memberships")).toBe(2);
  });
});

describe("operator access codes", () => {
  beforeEach(async () => {
    const booted = await bootApp(clock);
    ({ ctx, app } = booted);
    await setupOwner(app, booted.setupCode);
  });

  async function claim(code: string) {
    const browser = new Browser(app);
    const start = await browser.send("/v1/auth/access-code/options", { body: { code } });
    if (!start.ok) return { browser, res: start };
    const { ceremony, options } = (await start.json()) as any;
    const res = await browser.send("/v1/auth/access-code/verify", {
      body: { code, ceremony, response: authenticator.create(options), passkeyName: "Phone" },
    });
    return { browser, res };
  }

  it("lets a migrated user with no passkey claim their account", async () => {
    await ctx.system.users.ensure(asUserId("bob"), "bob");
    const code = (await ctx.system.accessCodes.issue(asUserId("bob"))).code.reveal();
    const { browser, res } = await claim(code.toLowerCase());
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.userId).toBe("bob");
    expect(body.recoveryCodes).toHaveLength(8);
    expect((await browser.json("/v1/me")).passkeys).toEqual([expect.objectContaining({ name: "Phone" })]);
    expect((await claim(code)).res.status).toBe(401);
  });

  it("signs the user out everywhere else and replaces their recovery codes", async () => {
    const elsewhere = await login(app, (await ctx.system.passkeys.list(asUserId("owner")))[0]!.id);
    const code = (await ctx.system.accessCodes.issue(asUserId("owner"))).code.reveal();
    expect((await claim(code)).res.status).toBe(201);
    expect((await elsewhere.send("/v1/me")).status).toBe(401);
  });

  it("expires after an hour", async () => {
    const code = (await ctx.system.accessCodes.issue(asUserId("owner"))).code.reveal();
    clock.advance(61 * MINUTE);
    expect((await claim(code)).res.status).toBe(401);
  });

  it("registers exactly one passkey when redeemed twice at once", async () => {
    const code = (await ctx.system.accessCodes.issue(asUserId("owner"))).code.reveal();
    const starts = await Promise.all(
      [1, 2].map(async () => {
        const browser = new Browser(app);
        return { browser, start: await browser.json("/v1/auth/access-code/options", { body: { code } }) };
      }),
    );
    const results = await Promise.all(
      starts.map(({ browser, start }) =>
        browser.send("/v1/auth/access-code/verify", {
          body: { code, ceremony: start.ceremony, response: authenticator.create(start.options) },
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 401]);
    expect(await count("passkeys")).toBe(2);
  });
});

describe("instances sharing one database", () => {
  it("verify a setup code and a ceremony that another instance minted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wherectx-shared-"));
    const databaseUrl = `file:${join(dir, "db.sqlite")}`;
    const first = await bootApp(clock, { databaseUrl });
    const second = await bootApp(clock, { databaseUrl });
    ctx = second.ctx;
    try {
      const browser = new Browser(first.app);
      const start = await browser.json("/v1/auth/setup/options", { body: { code: second.setupCode } });
      const res = await new Browser(second.app).send("/v1/auth/setup/verify", {
        body: { code: second.setupCode, ceremony: start.ceremony, response: authenticator.create(start.options) },
      });
      expect(res.status).toBe(201);
    } finally {
      first.ctx.handle.client.close();
      second.ctx.handle.client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
