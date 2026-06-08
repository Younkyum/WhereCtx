import { beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { WhereCtxConfig } from "../config.js";
import { createAppContext, type AppContext } from "../app/context.js";
import { buildApp } from "../app/server.js";

const ADMIN = "admin-token-strong-0123456789abcdef";
const DEVICE = "device-token-strong-0123456789abcdef";
const AGENT = "agent-token-strong-0123456789abcdef";

const config: WhereCtxConfig = {
  port: 0,
  host: "127.0.0.1",
  baseUrl: "http://localhost:8787",
  databaseUrl: ":memory:",
  userId: "default",
  bootstrapTokens: { admin: ADMIN, device: DEVICE, agent: AGENT },
  privacy: {
    defaultAgentAccess: "coarse",
    preciseRequiresReason: true,
    allowPreciseToAgent: false,
    hideHomeExactCoordinates: true,
    staleAfterSec: 900,
    retentionHours: 24,
    storeRawHistory: false,
  },
  geofence: { nearRadiusMultiplier: 3 },
};

let app: Hono;
let ctx: AppContext;

async function req(
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return app.request(path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

beforeEach(async () => {
  const built = await createAppContext(config);
  ctx = built.ctx;
  app = buildApp(ctx);
  // Register a home place for geofence tests.
  await req("/v1/places", {
    method: "POST",
    token: ADMIN,
    body: { name: "home", lat: 37.0, lon: 127.0, radiusM: 150, type: "home" },
  });
});

describe("health + auth", () => {
  it("serves /healthz", async () => {
    expect((await req("/healthz")).status).toBe(200);
  });

  it("rejects ingest without a token (401)", async () => {
    const r = await req("/v1/ingest", { method: "POST", body: { lat: 37, lon: 127 } });
    expect(r.status).toBe(401);
  });

  it("rejects ingest with an agent token lacking write_location (403)", async () => {
    const r = await req("/v1/ingest", {
      method: "POST",
      token: AGENT,
      body: { lat: 37, lon: 127 },
    });
    expect(r.status).toBe(403);
  });
});

describe("ingest -> presence flow", () => {
  it("accepts a device ingest and computes home status", async () => {
    const r = await req("/v1/ingest", {
      method: "POST",
      token: DEVICE,
      body: { lat: 37.0, lon: 127.0, source: "owntracks" },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, status: "home" });
  });

  it("returns coarse presence to an agent (no raw coords)", async () => {
    await req("/v1/ingest", { method: "POST", token: DEVICE, body: { lat: 37.0, lon: 127.0 } });
    const r = await req("/v1/presence", { token: AGENT });
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body.status).toBe("home");
    expect(body).not.toHaveProperty("lat");
    expect(body).not.toHaveProperty("geohash");
  });

  it("404s presence before any reading", async () => {
    const r = await req("/v1/presence", { token: AGENT });
    expect(r.status).toBe(404);
  });

  it("validates ingest bodies (400 on missing coords)", async () => {
    const r = await req("/v1/ingest", { method: "POST", token: DEVICE, body: { battery: 50 } });
    expect(r.status).toBe(400);
  });
});

describe("precise location gating", () => {
  it("denies precise at home even with a reason (home protection)", async () => {
    await req("/v1/ingest", { method: "POST", token: DEVICE, body: { lat: 37.0, lon: 127.0 } });
    const r = await req("/v1/presence/precise?reason=map", { token: AGENT });
    expect(r.status).toBe(403);
  });

  it("returns precise away-from-home once policy allows it", async () => {
    await req("/v1/privacy", { method: "PUT", token: ADMIN, body: { allowPreciseLocation: true } });
    await req("/v1/ingest", { method: "POST", token: DEVICE, body: { lat: 37.05, lon: 127.0 } });
    const r = await req("/v1/presence/precise?reason=user_requested_map", { token: AGENT });
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body.lat).toBe(37.05);
    expect(body.mapUrl).toContain("37.05");
  });

  it("denies precise without a reason when required", async () => {
    await req("/v1/privacy", { method: "PUT", token: ADMIN, body: { allowPreciseLocation: true } });
    await req("/v1/ingest", { method: "POST", token: DEVICE, body: { lat: 37.05, lon: 127.0 } });
    const r = await req("/v1/presence/precise", { token: AGENT });
    expect(r.status).toBe(403);
  });
});

describe("hidden mode", () => {
  it("withholds presence and events from agents", async () => {
    await req("/v1/ingest", { method: "POST", token: DEVICE, body: { lat: 37.05, lon: 127.0 } });
    await req("/v1/privacy", { method: "PUT", token: ADMIN, body: { defaultAgentAccess: "hidden" } });
    expect((await req("/v1/presence", { token: AGENT })).status).toBe(403);
    expect((await req("/v1/events", { token: AGENT })).status).toBe(403);
  });
});

describe("places privacy", () => {
  it("hides coordinates from agents but not admins", async () => {
    const agentList = (await (await req("/v1/places", { token: AGENT })).json()) as {
      places: Array<Record<string, unknown>>;
    };
    expect(agentList.places[0]).not.toHaveProperty("lat");
    expect(agentList.places[0]?.name).toBe("home");

    const adminList = (await (await req("/v1/places", { token: ADMIN })).json()) as {
      places: Array<Record<string, unknown>>;
    };
    expect(adminList.places[0]).toHaveProperty("lat", 37.0);
  });

  it("deletes a place", async () => {
    expect((await req("/v1/places/home", { method: "DELETE", token: ADMIN })).status).toBe(200);
    expect((await req("/v1/places/home", { method: "DELETE", token: ADMIN })).status).toBe(404);
  });

  it("adds a place from the current location", async () => {
    await req("/v1/ingest", { method: "POST", token: DEVICE, body: { lat: 37.51, lon: 127.52 } });
    const r = await req("/v1/places", {
      method: "POST",
      token: ADMIN,
      body: { name: "here", type: "custom", useCurrentLocation: true },
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { place: { name: string; lat: number; radiusM: number } };
    expect(body.place.name).toBe("here");
    expect(body.place.lat).toBe(37.51);
    expect(body.place.radiusM).toBe(150);
  });

  it("400s useCurrentLocation when there is no current location", async () => {
    const r = await req("/v1/places", {
      method: "POST",
      token: ADMIN,
      body: { name: "x", type: "custom", useCurrentLocation: true },
    });
    expect(r.status).toBe(400);
  });

  it("re-evaluates the current status when a place is added at the location", async () => {
    // Stand far from home: status freezes to "away" at ingest time.
    await req("/v1/ingest", { method: "POST", token: DEVICE, body: { lat: 37.51, lon: 127.52 } });
    let body = (await (await req("/v1/presence", { token: AGENT })).json()) as { status: string };
    expect(body.status).toBe("away");

    // Register "work" right here — status must flip immediately, not on the next reading.
    await req("/v1/places", {
      method: "POST",
      token: ADMIN,
      body: { name: "work", type: "work", useCurrentLocation: true },
    });
    body = (await (await req("/v1/presence", { token: AGENT })).json()) as { status: string };
    expect(body.status).toBe("work");

    // Removing it flips back to "away" without waiting for a new reading.
    await req("/v1/places/work", { method: "DELETE", token: ADMIN });
    body = (await (await req("/v1/presence", { token: AGENT })).json()) as { status: string };
    expect(body.status).toBe("away");
  });
});

describe("token management", () => {
  it("lists tokens without secrets and creates new ones", async () => {
    const list = (await (await req("/v1/tokens", { token: ADMIN })).json()) as {
      tokens: Array<Record<string, unknown>>;
    };
    expect(list.tokens.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(list.tokens)).not.toContain("token_hash");

    const created = await req("/v1/tokens", {
      method: "POST",
      token: ADMIN,
      body: { name: "phone", role: "device" },
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { secret: string };
    expect(body.secret).toMatch(/^wctx_/);

    // The freshly-created device token works for ingest.
    const ingest = await req("/v1/ingest", {
      method: "POST",
      token: body.secret,
      body: { lat: 37.0, lon: 127.0 },
    });
    expect(ingest.status).toBe(200);
  });

  it("forbids token management for non-admins", async () => {
    expect((await req("/v1/tokens", { token: AGENT })).status).toBe(403);
  });
});

describe("auth boundary hardening", () => {
  it("accepts ?token= on ingest only, rejects it on read/admin routes", async () => {
    // ingest accepts query token (device clients)
    const ingest = await app.request("/v1/ingest?token=" + DEVICE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lat: 37.0, lon: 127.0 }),
    });
    expect(ingest.status).toBe(200);

    // precise + admin routes reject the query token (credential-in-URL leak)
    expect((await app.request("/v1/presence/precise?reason=map&token=" + AGENT)).status).toBe(401);
    expect((await app.request("/v1/tokens?token=" + ADMIN)).status).toBe(401);
  });

  it("rejects a raw (non-Bearer) Authorization header", async () => {
    const r = await app.request("/v1/presence", { headers: { authorization: AGENT } });
    expect(r.status).toBe(401);
  });

  it("enforces the device-can-never-read guarantee at the read boundary", async () => {
    expect((await req("/v1/presence", { token: DEVICE })).status).toBe(403);
    expect((await req("/v1/places", { token: DEVICE })).status).toBe(403);
    expect((await req("/v1/tokens", { token: DEVICE })).status).toBe(403);
    expect((await req("/v1/events", { token: DEVICE })).status).toBe(403);
  });

  it("restricts /history to admins (manage_privacy)", async () => {
    expect((await req("/v1/presence/history", { token: AGENT })).status).toBe(403);
    expect((await req("/v1/presence/history", { token: ADMIN })).status).toBe(200);
  });

  it("rejects malformed JSON with 400", async () => {
    const r = await app.request("/v1/places", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(r.status).toBe(400);
  });

  it("rejects oversized bodies with 413 (before auth)", async () => {
    const big = "x".repeat(70 * 1024);
    const r = await app.request("/v1/ingest", {
      method: "POST",
      headers: { authorization: `Bearer ${DEVICE}`, "content-type": "application/json" },
      body: JSON.stringify({ lat: 37, lon: 127, note: big }),
    });
    expect(r.status).toBe(413);
  });

  it("does not echo raw zod issues; detail is a string list", async () => {
    const r = await req("/v1/places", { method: "POST", token: ADMIN, body: { name: "x" } });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { detail: unknown };
    expect(Array.isArray(body.detail)).toBe(true);
    expect(typeof (body.detail as unknown[])[0]).toBe("string");
  });
});

describe("events privacy", () => {
  it("strips placeName for agents but not admins", async () => {
    await req("/v1/ingest", { method: "POST", token: DEVICE, body: { lat: 37.0, lon: 127.0 } }); // home
    await req("/v1/ingest", { method: "POST", token: DEVICE, body: { lat: 37.05, lon: 127.0 } }); // away

    const agentEvents = (await (await req("/v1/events", { token: AGENT })).json()) as {
      events: Array<Record<string, unknown>>;
    };
    expect(agentEvents.events.some((e) => "placeName" in e)).toBe(false);

    const adminEvents = (await (await req("/v1/events", { token: ADMIN })).json()) as {
      events: Array<Record<string, unknown>>;
    };
    expect(adminEvents.events.some((e) => e.placeName === "home")).toBe(true);
  });

  it("fails closed on /events when privacy settings are missing", async () => {
    await ctx.handle.client.execute("DELETE FROM privacy_settings");
    const r = await req("/v1/events", { token: AGENT });
    expect(r.status).toBe(500);
  });
});

describe("privacy change over the API", () => {
  it("reports privacyChanged=true when the mode changes", async () => {
    await req("/v1/ingest", { method: "POST", token: DEVICE, body: { lat: 37.05, lon: 127.0 } });
    const r = await req("/v1/privacy", {
      method: "PUT",
      token: ADMIN,
      body: { defaultAgentAccess: "hidden" },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ privacyChanged: true });
  });
});

describe("OwnTracks contract", () => {
  it("acks non-location messages with an empty array", async () => {
    const r = await req("/v1/ingest/owntracks", {
      method: "POST",
      token: DEVICE,
      body: { _type: "transition", lat: 37, lon: 127 },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });

  it("keeps the array contract on a bad payload", async () => {
    const r = await req("/v1/ingest/owntracks", {
      method: "POST",
      token: DEVICE,
      body: { _type: "location", lat: 999, lon: 0 },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
  });
});
