import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { WhereCtxConfig } from "../config.js";
import { createAppContext, type AppContext } from "../app/context.js";
import { buildApp } from "../app/server.js";
import { hashToken } from "../auth/secrets.js";
import { asUserId } from "../types.js";
import { createDb, migrationsFolder } from "./index.js";

const LEGACY_ADMIN = "legacy-admin-token-strong-0123456789abcdef";
const PRE_MULTI_USER_MIGRATIONS = 4;
const PRE_ACCOUNTS_MIGRATIONS = 5;

let dir: string;
let dbUrl: string;
const opened: AppContext[] = [];

function config(defaultUserId: string): WhereCtxConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    baseUrl: "http://localhost:8787",
    databaseUrl: dbUrl,
    defaultUserId: asUserId(defaultUserId),
    bootstrapTokens: {},
    privacy: {
      defaultAgentAccess: "coarse",
      preciseRequiresReason: true,
      allowPreciseToAgent: false,
      hideHomeExactCoordinates: true,
      protectHomePlace: true,
      staleAfterSec: 900,
      retentionHours: 24,
      storeRawHistory: false,
    },
    geofence: { nearRadiusMultiplier: 3 },
    trustProxy: "none",
    allowMemberWorkspaces: true,
    webhooks: { allowPrivateTargets: true },
    events: { retentionHours: 720 },
    sharing: { auditRetentionDays: 365 },
    oauth: { dynamicRegistration: false },
    geo: { operatorKeys: {}, operatorKeyForAll: false, fake: false },
    activity: { accessLogRetentionDays: 90, ingestLogRetentionDays: 7 },
  };
}

/** A copy of drizzle/ holding only the first `count` migrations. */
function firstMigrations(count: number): string {
  const folder = join(dir, `drizzle-first-${count}`);
  cpSync(migrationsFolder(), folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.slice(0, count);
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

const OWNED_TABLES = ["tokens", "presence_events", "webhooks", "reminders"] as const;

/**
 * Build a DB as a pre-0004 install left it: old schema plus one row per table.
 * `settingsOwner` is the USER_ID that install booted with (it keyed the single
 * privacy_settings row); null models an install that never wrote that row.
 */
async function seedLegacyInstall(settingsOwner: string | null): Promise<void> {
  const handle = createDb(dbUrl);
  await migrate(handle.db, { migrationsFolder: firstMigrations(PRE_MULTI_USER_MIGRATIONS) });
  const now = new Date().toISOString();
  const owner = settingsOwner ?? "default";
  await handle.client.batch(
    [
      {
        sql: "INSERT INTO tokens (id, name, role, scopes, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        args: [
          "tok1",
          "admin (bootstrap)",
          "admin",
          JSON.stringify(["read_presence", "manage_places", "manage_tokens", "manage_privacy"]),
          hashToken(LEGACY_ADMIN),
          now,
        ],
      },
      {
        sql: "INSERT INTO presence_events (id, type, status, created_at) VALUES (?, ?, ?, ?)",
        args: ["ev1", "presence.updated", "home", now],
      },
      {
        sql: "INSERT INTO webhooks (id, url, events, created_at) VALUES (?, ?, ?, ?)",
        args: ["wh1", "http://127.0.0.1:9/legacy", JSON.stringify(["*"]), now],
      },
      {
        sql: "INSERT INTO reminders (id, place_name, message, created_at) VALUES (?, ?, ?, ?)",
        args: ["rm1", "home", "water the plants", now],
      },
      {
        sql: "INSERT INTO places (id, user_id, name, lat, lon, radius_m, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        args: ["pl1", owner, "home", 37, 127, 150, "home", now, now],
      },
      {
        sql: "INSERT INTO presence (user_id, status, precise_lat, precise_lon, source, privacy_mode, updated_at, received_at, stale_after_sec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        args: [owner, "home", 37, 127, "manual", "coarse", now, now, 900],
      },
      ...(settingsOwner === null
        ? []
        : [
            {
              sql: "INSERT INTO privacy_settings (user_id, default_agent_access, updated_at) VALUES (?, ?, ?)",
              args: [settingsOwner, "coarse", now],
            },
          ]),
    ],
    "write",
  );
  handle.client.close();
}

async function boot(defaultUserId: string) {
  const { ctx, bootstrap } = await createAppContext(config(defaultUserId));
  opened.push(ctx);
  const app = buildApp(ctx);
  const get = async (path: string): Promise<any> => {
    const r = await app.request(path, { headers: { authorization: `Bearer ${LEGACY_ADMIN}` } });
    expect(r.status).toBe(200);
    return r.json();
  };
  const owners = async (table: string): Promise<unknown[]> =>
    (await ctx.handle.client.execute(`SELECT DISTINCT user_id FROM ${table}`)).rows.map(
      (r) => r.user_id,
    );
  return { ctx, bootstrap, get, owners };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wherectx-migration-"));
  dbUrl = `file:${join(dir, "wherectx.db")}`;
});

afterEach(() => {
  for (const ctx of opened.splice(0)) ctx.handle.client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("migration 0004 on a pre-multi-user install", () => {
  it("gives every legacy row to the USER_ID that keyed the settings row", async () => {
    await seedLegacyInstall("alice");
    const { ctx, bootstrap, get, owners } = await boot("alice");

    for (const table of OWNED_TABLES) expect(await owners(table)).toEqual(["alice"]);
    expect(await owners("places")).toEqual(["alice"]);
    const presence = await ctx.forUser(asUserId("alice")).presence.getCurrent();
    expect(presence).toMatchObject({ status: "home", precise: { lat: 37, lon: 127 } });

    expect(bootstrap.seed.generatedAdminSecret).toBeUndefined();
    expect((await get("/v1/tokens")).tokens.map((t: any) => t.id)).toEqual(["tok1"]);
    expect((await get("/v1/events")).events.map((e: any) => e.id)).toEqual(["ev1"]);
    expect((await get("/v1/webhooks")).webhooks.map((w: any) => w.id)).toEqual(["wh1"]);
    expect((await get("/v1/places")).places.map((p: any) => p.id)).toEqual(["pl1"]);
    const reminders = await ctx.forUser(asUserId("alice")).reminders.listActive();
    expect(reminders.map((r) => r.id)).toEqual(["rm1"]);
  });

  it("falls back to 'default' when the install never wrote a settings row", async () => {
    await seedLegacyInstall(null);
    const { get, owners } = await boot("default");

    for (const table of OWNED_TABLES) expect(await owners(table)).toEqual(["default"]);
    expect((await get("/v1/tokens")).tokens.map((t: any) => t.id)).toEqual(["tok1"]);
  });

  it("leaves user_id NOT NULL with no default", async () => {
    await seedLegacyInstall("alice");
    const { ctx } = await boot("alice");
    for (const table of OWNED_TABLES) {
      const cols = (await ctx.handle.client.execute(`PRAGMA table_info(${table})`)).rows;
      expect(cols.find((c) => c.name === "user_id")).toMatchObject({ notnull: 1, dflt_value: null });
    }
    await expect(
      ctx.handle.client.execute({
        sql: "INSERT INTO reminders (id, place_name, message, created_at) VALUES (?, ?, ?, ?)",
        args: ["rm2", "home", "x", new Date().toISOString()],
      }),
    ).rejects.toThrow(/NOT NULL/);
  });
});

describe("migration 0005 on a phase-1 install", () => {
  async function seedPhaseOneInstall(owners: string[]): Promise<void> {
    const handle = createDb(dbUrl);
    await migrate(handle.db, { migrationsFolder: firstMigrations(PRE_ACCOUNTS_MIGRATIONS) });
    const now = new Date().toISOString();
    await handle.client.batch(
      owners.map((owner) => ({
        sql: "INSERT INTO privacy_settings (user_id, default_agent_access, updated_at) VALUES (?, ?, ?)",
        args: [owner, "coarse", now],
      })),
      "write",
    );
    handle.client.close();
  }

  async function ownership(ctx: AppContext) {
    const rows = await ctx.handle.client.execute(
      "SELECT u.id AS user, w.id AS ws, w.name, m.role FROM users u JOIN memberships m ON m.user_id = u.id JOIN workspaces w ON w.id = m.workspace_id ORDER BY u.id",
    );
    return rows.rows.map((r) => ({ user: r.user, ws: r.ws, name: r.name, role: r.role }));
  }

  it("makes every existing user the owner of their own Default workspace", async () => {
    await seedPhaseOneInstall(["alice", "bob"]);
    const { ctx, bootstrap } = await boot("alice");

    const rows = await ownership(ctx);
    expect(rows).toEqual([
      { user: "alice", ws: expect.stringMatching(/^[0-9a-f]{32}$/), name: "Default", role: "owner" },
      { user: "bob", ws: expect.stringMatching(/^[0-9a-f]{32}$/), name: "Default", role: "owner" },
    ]);
    expect(rows[0]!.ws).not.toBe(rows[1]!.ws);
    const users = await ctx.handle.client.execute("SELECT created_at, webauthn_handle FROM users");
    for (const r of users.rows) expect(new Date(String(r.created_at)).toISOString()).toBe(r.created_at);
    const handles = users.rows.map((r) => String(r.webauthn_handle));
    for (const h of handles) expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(handles).size).toBe(handles.length);

    expect(bootstrap.setupCode).toBeDefined();
  });

  it("does not give the migrated owner a second workspace on boot", async () => {
    await seedPhaseOneInstall(["alice"]);
    await boot("alice");
    opened.splice(0).forEach((ctx) => ctx.handle.client.close());
    const { ctx } = await boot("alice");
    expect(await ownership(ctx)).toHaveLength(1);
  });

  it("creates the Default workspace for USER_ID on a fresh install", async () => {
    const { ctx } = await boot("carol");
    expect(await ownership(ctx)).toEqual([
      { user: "carol", ws: expect.any(String), name: "Default", role: "owner" },
    ]);
  });
});

describe("migration 0009 on an install that ran the activity logs", () => {
  const ACTIVITY_LOG_MIGRATIONS = 9;

  it("comes after 0007_access_log and 0008_ingest_log", () => {
    const journal = JSON.parse(readFileSync(join(migrationsFolder(), "meta", "_journal.json"), "utf8"));
    expect(journal.entries.slice(7).map((e: { tag: string }) => e.tag)).toEqual([
      "0007_access_log",
      "0008_ingest_log",
      "0009_oauth_store",
      "0010_geo",
    ]);
  });

  it("adds oauth_store and keeps the access log", async () => {
    const handle = createDb(dbUrl);
    await migrate(handle.db, { migrationsFolder: firstMigrations(ACTIVITY_LOG_MIGRATIONS) });
    const now = new Date().toISOString();
    await handle.client.execute({
      sql: "INSERT INTO access_log (id, user_id, credential_kind, credential_id, credential_name, surface, action, precise, outcome, created_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: ["al1", "alice", "token", "tok1", "Claude", "mcp", "get_presence", 0, "allowed", now, now],
    });
    handle.client.close();

    const { ctx } = await boot("alice");
    const kept = await ctx.handle.client.execute("SELECT id, credential_name FROM access_log");
    expect(kept.rows.map((r) => ({ ...r }))).toEqual([{ id: "al1", credential_name: "Claude" }]);
    const tables = await ctx.handle.client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'oauth_store'");
    expect(tables.rows).toHaveLength(1);
  });
});
