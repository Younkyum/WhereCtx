import { beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { WhereCtxConfig } from "../config.js";
import { createAppContext, type AppContext } from "../app/context.js";
import type { VerifiedToken } from "../auth/tokens.js";
import { ROLE_SCOPES } from "../types.js";
import type { NormalizedReading } from "../normalizer/types.js";
import { buildMcpServer } from "./server.js";

const config: WhereCtxConfig = {
  port: 0,
  host: "127.0.0.1",
  baseUrl: "http://localhost:8787",
  databaseUrl: ":memory:",
  userId: "default",
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
  webhooks: { allowPrivateTargets: false },
  events: { retentionHours: 720 },
};

const agentToken: VerifiedToken = {
  id: "t1",
  name: "agent",
  role: "agent",
  scopes: ROLE_SCOPES.agent,
  createdAt: "2026-06-05T00:00:00.000Z",
};

const adminToken: VerifiedToken = {
  id: "t2",
  name: "admin",
  role: "admin",
  scopes: ROLE_SCOPES.admin,
  createdAt: "2026-06-05T00:00:00.000Z",
};

function reading(lat: number, lon: number): NormalizedReading {
  return {
    precise: { lat, lon, accuracyM: 15 },
    motion: "walking",
    source: "owntracks",
    updatedAt: new Date().toISOString(),
  };
}

let ctx: AppContext;
let client: Client;

async function connect(token: VerifiedToken = agentToken): Promise<void> {
  const server = buildMcpServer(ctx, token);
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
  await ctx.placesStore.upsert("default", {
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
    const places = await ctx.placesStore.list("default");
    expect(places.some((p) => p.name === "gym")).toBe(true);
  });

  it("remember_current_place uses the current location", async () => {
    await ctx.service.processReading(reading(37.61, 127.22));
    await connect();
    const { data } = await callJson("remember_current_place", { name: "spot" });
    expect(data.name).toBe("spot");
    const p = (await ctx.placesStore.list("default")).find((x) => x.name === "spot");
    expect(p?.lat).toBe(37.61);
  });

  it("remember_current_place errors when there is no location", async () => {
    await connect();
    const { isError } = await callJson("remember_current_place", { name: "nope" });
    expect(isError).toBe(true);
  });

  it("get_presence returns coarse status with no raw coordinates", async () => {
    await ctx.service.processReading(reading(37.0, 127.0));
    await connect();
    const { data } = await callJson("get_presence");
    expect(data.status).toBe("home");
    expect(data).not.toHaveProperty("lat");
    expect(data).not.toHaveProperty("geohash");
  });

  it("get_precise_location is denied at home (home protection)", async () => {
    await ctx.service.processReading(reading(37.0, 127.0));
    await connect();
    const { isError } = await callJson("get_precise_location", { reason: "map" });
    expect(isError).toBe(true);
  });

  it("is_near_place returns booleans only", async () => {
    await ctx.service.processReading(reading(37.0, 127.0));
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
    await ctx.service.processReading(reading(37.0, 127.0));
    await connect();
    const { data } = await callJson("get_location_age");
    expect(typeof data.updatedAgoSec).toBe("number");
    expect(data.stale).toBe(false);
  });

  it("withholds presence in hidden mode", async () => {
    await ctx.service.processReading(reading(37.05, 127.0));
    await ctx.service.changePrivacySettings({ defaultAgentAccess: "hidden" });
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
    const active = await ctx.remindersStore.listActive();
    expect(active).toHaveLength(1);
  });

  it("create_location_reminder rejects an unknown place name", async () => {
    await connect();
    const { isError } = await callJson("create_location_reminder", {
      place: "nonexistent",
      message: "x",
    });
    expect(isError).toBe(true);
    expect(await ctx.remindersStore.countActive()).toBe(0);
  });

  it("create_location_reminder is refused in hidden mode", async () => {
    await ctx.service.changePrivacySettings({ defaultAgentAccess: "hidden" });
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
      expect(await ctx.placesStore.get("default", "home2")).toBeNull();
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
      const home = await ctx.placesStore.get("default", "home");
      expect(home?.lat).toBe(37.0); // unchanged
    });

    it("blocks remember_current_place for the home place", async () => {
      await ctx.service.processReading(reading(37.61, 127.22));
      await connect();
      const { isError } = await callJson("remember_current_place", {
        name: "home",
      });
      expect(isError).toBe(true);
      const home = await ctx.placesStore.get("default", "home");
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
      const home = await ctx.placesStore.get("default", "home");
      expect(home?.lat).toBe(38.0);
    });

    it("allows agent home writes when the dashboard toggle is off", async () => {
      await ctx.service.changePrivacySettings({ protectHomePlace: false });
      await connect();
      const { isError } = await callJson("create_place", {
        name: "home",
        type: "home",
        lat: 39.0,
        lon: 129.0,
      });
      expect(isError).toBe(false);
      const home = await ctx.placesStore.get("default", "home");
      expect(home?.lat).toBe(39.0);
    });
  });
});
