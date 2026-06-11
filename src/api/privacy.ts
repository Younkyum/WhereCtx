/**
 * Privacy settings REST API (plan section 9.3, 9.9).
 *   GET /v1/privacy -> current settings (manage_privacy)
 *   PUT /v1/privacy -> update settings (manage_privacy); emits privacy_changed
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../app/context.js";
import { bearerAuth, requireScope } from "./middleware.js";
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
  })
  .partial();

export function privacyRouter(ctx: AppContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", bearerAuth(ctx));
  app.use("*", requireScope("manage_privacy"));

  const userId = ctx.config.userId;

  app.get("/", async (c) => {
    const settings = await ctx.settings.get(userId);
    if (!settings) return c.json({ error: "privacy settings not initialized" }, 500);
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
    const { settings, event } = await ctx.service.changePrivacySettings(parsed.data);
    if (event) await ctx.onEvents?.([event]);
    return c.json({ settings, privacyChanged: event !== null });
  });

  return app;
}
