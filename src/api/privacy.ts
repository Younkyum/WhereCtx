/**
 * Privacy settings REST API (plan section 9.3, 9.9).
 *   GET /v1/privacy -> current settings (manage_privacy)
 *   PUT /v1/privacy -> update settings (manage_privacy); emits privacy_changed.
 *                      Turning on a maps switch that sends more out needs a
 *                      fresh session (EGRESS_WIDENINGS).
 */

import { Hono } from "hono";
import { z } from "zod";
import type { RouteContext } from "../app/context.js";
import { GEO_PROVIDERS } from "../geo/types.js";
import { hasFreshAuth } from "../accounts/types.js";
import type { PrivacySettings } from "../types.js";
import { refuse } from "./accessAudit.js";
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

/**
 * Switches that let more of the person's location leave the server: turning
 * one on (or skipProviderNearHome off) needs the person in the dashboard
 * with a fresh passkey, never a token. Turning them back is free.
 */
const EGRESS_WIDENINGS: ReadonlyArray<{ key: keyof PrivacySettings; widened: boolean }> = [
  { key: "geoEnabled", widened: true },
  { key: "etaToAgents", widened: true },
  { key: "areaToAgents", widened: true },
  { key: "areaOnHome", widened: true },
  { key: "skipProviderNearHome", widened: false },
];

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
    const before = await c.get("scope").settings.getOrSeed();
    const widened = EGRESS_WIDENINGS.filter(
      ({ key, widened }) => parsed.data[key] === widened && before[key] !== widened,
    ).map(({ key }) => key);
    if (widened.length > 0) {
      const principal = c.get("principal");
      if (principal.via !== "session") {
        return refuse(c, 403, "forbidden", `turning on ${widened.join(", ")} sends more of the location out; only the person can, in the dashboard`);
      }
      if (!hasFreshAuth(principal.reauthAt, ctx.clock())) {
        return c.json(
          { error: "confirm with your passkey first (POST /v1/me/reauth)", code: "reauth_required", settings: widened },
          403,
        );
      }
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
