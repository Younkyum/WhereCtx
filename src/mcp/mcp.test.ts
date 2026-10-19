import { beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { WhereCtxConfig } from "../config.js";
import { createAppContext, type AppContext, type UserScope } from "../app/context.js";
import type { Principal } from "../auth/principal.js";
import { ROLE_SCOPES, asUserId } from "../types.js";
import type { NormalizedReading } from "../normalizer/types.js";
import { buildMcpServer } from "./server.js";

const config: WhereCtxConfig = {
  port: 0,
  host: "127.0.0.1",
  baseUrl: "http://localhost:8787",
  databaseUrl: ":memory:",
  defaultUserId: asUserId("default"),
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
  webhooks: { allowPrivateTargets: false },
  events: { retentionHours: 720 },
  sharing: { auditRetentionDays: 365 },
  oauth: { dynamicRegistration: false },
  activity: { accessLogRetentionDays: 90, ingestLogRetentionDays: 7 },
};

const USER = asUserId("default");

const agentToken: Principal = { via: "token", userId: USER, scopes: ROLE_SCOPES.agent, tokenId: "agent-id", tokenName: "agent" };
const adminToken: Principal = { via: "token", userId: USER, scopes: ROLE_SCOPES.admin, tokenId: "admin-id", tokenName: "admin" };

function reading(lat: number, lon: number): NormalizedReading {
  return {
    precise: { lat, lon, accuracyM: 15 },
    motion: "walking",
    source: "owntracks",
    updatedAt: new Date().toISOString(),
  };
}

let ctx: AppContext;
let user: UserScope;
let client: Client;

async function connect(principal: Principal = agentToken): Promise<void> {
  const server = buildMcpServer(ctx.forUser(principal.userId), principal, ctx);
  client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await client.connect(clientT);
}

async function callJson(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  return { data: JSON.parse(res.content[0]!.text), isError: res.isError ?? false };
}

beforeEach(async () => {
  const built = await createAppContext(config);
  ctx = built.ctx;
  user = ctx.forUser(USER);
  await user.places.upsert({
    name: "home",
    lat: 37.0,
    lon: 127.0,
    radiusM: 150,
    type: "home",
  });
});

describe("MCP server", () => {
  it("exposes the expected tools (incl. place management)", async () => {
    await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "create_location_reminder",
        "create_place",
        "get_location_age",
        "get_precise_location",
        "get_presence",
        "is_near_place",
        "list_places",
        "list_recent_presence_events",
        "remember_current_place",
      ].sort(),
    );
  });

  it("create_place registers a geofence", async () => {
    await connect();
    const { data } = await callJson("create_place", { name: "gym", type: "custom", lat: 37.4, lon: 127.1, radiusM: 120 });
    expect(data.name).toBe("gym");
    const places = await user.places.list();
    expect(places.some((p) => p.name === "gym")).toBe(true);
  });

  it("remember_current_place uses the current location", async () => {
    await user.presence.processReading(reading(37.61, 127.22));
    await connect();
    const { data } = await callJson("remember_current_place", { name: "spot" });
    expect(data.name).toBe("spot");
    const p = (await user.places.list()).find((x) => x.name === "spot");
    expect(p?.lat).toBe(37.61);
  });

  it("remember_current_place errors when there is no location", async () => {
    await connect();
    const { isError } = await callJson("remember_current_place", { name: "nope" });
    expect(isError).toBe(true);
  });

  it("get_presence returns coarse status with no raw coordinates", async () => {
    await user.presence.processReading(reading(37.0, 127.0));
    await connect();
    const { data } = await callJson("get_presence");
    expect(data.status).toBe("home");
    expect(data).not.toHaveProperty("lat");
    expect(data).not.toHaveProperty("geohash");
  });

  it("get_precise_location is denied at home (home protection)", async () => {
    await user.presence.processReading(reading(37.0, 127.0));
    await connect();
    const { isError } = await callJson("get_precise_location", { reason: "map" });
    expect(isError).toBe(true);
  });

  it("is_near_place returns booleans only", async () => {
    await user.presence.processReading(reading(37.0, 127.0));
    await connect();
    const { data } = await callJson("is_near_place", { name: "home" });
    expect(data).toEqual({ name: "home", inside: true, near: true });
    expect(data).not.toHaveProperty("lat");
  });

  it("list_places hides coordinates from agents", async () => {
    await connect();
    const { data } = await callJson("list_places");
    expect(data.places[0]).toEqual({ name: "home", type: "home" });
  });

  it("get_location_age reports age and stale flag", async () => {
    await user.presence.processReading(reading(37.0, 127.0));
    await connect();
    const { data } = await callJson("get_location_age");
    expect(typeof data.updatedAgoSec).toBe("number");
    expect(data.stale).toBe(false);
  });

  it("withholds presence in hidden mode", async () => {
    await user.presence.processReading(reading(37.05, 127.0));
    await user.presence.changePrivacySettings({ defaultAgentAccess: "hidden" });
    await connect();
    const presence = await callJson("get_presence");
    expect(presence.data.status).toBe("hidden");
    const near = await callJson("is_near_place", { name: "home" });
    expect(near.data.hidden).toBe(true);
  });

  it("create_location_reminder stores a reminder for an existing place", async () => {
    await connect();
    const { data } = await callJson("create_location_reminder", {
      place: "home",
      message: "water the plants",
    });
    expect(data.id).toBeDefined();
    expect(data.place).toBe("home");
    const active = await user.reminders.listActive();
    expect(active).toHaveLength(1);
  });

  it("create_location_reminder rejects an unknown place name", async () => {
    await connect();
    const { isError } = await callJson("create_location_reminder", {
      place: "nonexistent",
      message: "x",
    });
    expect(isError).toBe(true);
    expect(await user.reminders.countActive()).toBe(0);
  });

  it("create_location_reminder is refused in hidden mode", async () => {
    await user.presence.changePrivacySettings({ defaultAgentAccess: "hidden" });
    await connect();
    const { isError } = await callJson("create_location_reminder", {
      place: "home",
      message: "x",
    });
    expect(isError).toBe(true);
  });

  describe("home place protection", () => {
    it("blocks an agent from creating a home-typed place", async () => {
      await connect();
      const { isError, data } = await callJson("create_place", {
        name: "home2",
        type: "home",
        lat: 38.0,
        lon: 128.0,
      });
      expect(isError).toBe(true);
      expect(data.error).toContain("manage_places");
      expect(await user.places.get("home2")).toBeNull();
    });

    it("blocks an agent from overwriting the existing home place (even as type custom)", async () => {
      await connect();
      const { isError } = await callJson("create_place", {
        name: "home",
        type: "custom",
        lat: 0,
        lon: 0,
      });
      expect(isError).toBe(true);
      const home = await user.places.get("home");
      expect(home?.lat).toBe(37.0); // unchanged
    });

    it("blocks remember_current_place for the home place", async () => {
      await user.presence.processReading(reading(37.61, 127.22));
      await connect();
      const { isError } = await callJson("remember_current_place", {
        name: "home",
      });
      expect(isError).toBe(true);
      const home = await user.places.get("home");
      expect(home?.lat).toBe(37.0); // unchanged
    });

    it("still allows agents to create non-home places while protection is on", async () => {
      await connect();
      const { isError } = await callJson("create_place", {
        name: "cafe",
        type: "custom",
        lat: 37.5,
        lon: 127.0,
      });
      expect(isError).toBe(false);
    });

    it("allows admin tokens to write home places regardless of the toggle", async () => {
      await connect(adminToken);
      const { isError } = await callJson("create_place", {
        name: "home",
        type: "home",
        lat: 38.0,
        lon: 128.0,
      });
      expect(isError).toBe(false);
      const home = await user.places.get("home");
      expect(home?.lat).toBe(38.0);
    });

    it("allows agent home writes when the dashboard toggle is off", async () => {
      await user.presence.changePrivacySettings({ protectHomePlace: false });
      await connect();
      const { isError } = await callJson("create_place", {
        name: "home",
        type: "home",
        lat: 39.0,
        lon: 129.0,
      });
      expect(isError).toBe(false);
      const home = await user.places.get("home");
      expect(home?.lat).toBe(39.0);
    });
  });
});
