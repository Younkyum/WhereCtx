/**
 * Privacy settings REST API (plan section 9.3, 9.9).
 *   GET /v1/privacy -> current settings (manage_privacy)
 *   PUT /v1/privacy -> update settings (manage_privacy); emits privacy_changed
 */

import { Hono } from "hono";
import { z } from "zod";
import type { RouteContext } from "../app/context.js";
import { GEO_PROVIDERS } from "../geo/types.js";
import { requireScope } from "./middleware.js";
import { zodMessages } from "./validation.js";
import type { AppEnv } from "./types.js";

const PatchSchema = z
  .object({
    defaultAgentAccess: z.enum(["hidden", "coarse", "precise"]),
    allowPreciseLocation: z.boolean(),
    preciseRequiresReason: z.boolean(),
    preciseRequiresApproval: z.boolean(),
    hideHomeExactCoordinates: z.boolean(),
    protectHomePlace: z.boolean(),
    retentionHours: z.number().int().min(0).max(8760),
    storeRawHistory: z.boolean(),
    sharingPaused: z.boolean(),
    geoEnabled: z.boolean(),
    areaToAgents: z.boolean(),
    areaToPeople: z.boolean(),
    etaToAgents: z.boolean(),
    areaOnHome: z.boolean(),
    skipProviderNearHome: z.boolean(),
    geoProvider: z.enum(GEO_PROVIDERS).nullable(),
  })
  .partial();

/** Settings that change whether, or for whom, the area is looked up. */
const AREA_SWITCHES = ["geoEnabled", "skipProviderNearHome", "geoProvider", "areaToAgents", "areaOnHome"] as const;

export function privacyRouter(ctx: RouteContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireScope("manage_privacy"));

  app.get("/", async (c) => {
    const settings = await c.get("scope").settings.getOrSeed();
    return c.json({ settings });
  });

  app.put("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "request body must be valid JSON" }, 400);
    }
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid settings", detail: zodMessages(parsed.error) }, 400);
    }
    const { settings, event } = await c.get("scope").presence.changePrivacySettings(
      parsed.data,
    );
    if (event) await ctx.onEvents?.([event]);
    // Turning maps off drops the area at once; turning them on looks it up.
    if (AREA_SWITCHES.some((key) => key in parsed.data)) c.get("scope").geo.refreshArea();
    return c.json({ settings, privacyChanged: event !== null });
  });

  return app;
}
