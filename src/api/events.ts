/**
 * Presence events REST API (plan section 9.7/9.8).
 *   GET /v1/events -> recent presence events (read_presence)
 *
 * Privacy:
 * - Withheld entirely in `hidden` mode (fail CLOSED if settings are missing).
 * - For non-admin (agent) callers, `placeName` is stripped so the event feed
 *   cannot be used as a back-door movement log of named places + exact times
 *   (review findings P4/P5). Admins see full events.
 */

import { Hono } from "hono";
import type { AppContext } from "../app/context.js";
import { accessAtLeast } from "../privacy/policy.js";
import type { PresenceEvent } from "../types.js";
import { bearerAuth, requireScope } from "./middleware.js";
import { parseLimit } from "./validation.js";
import type { AppEnv } from "./types.js";

function stripPlace(e: PresenceEvent): PresenceEvent {
  const { placeName: _p, ...rest } = e;
  return rest;
}

export function eventsRouter(ctx: AppContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", bearerAuth(ctx));

  app.get("/", requireScope("read_presence"), async (c) => {
    const settings = await ctx.settings.get(ctx.config.userId);
    if (!settings) {
      // Fail closed: never expose events when policy is unknown.
      return c.json({ error: "privacy settings not initialized" }, 500);
    }
    const isAdmin = c.get("token").scopes.includes("manage_privacy");
    if (!isAdmin && !accessAtLeast(settings.defaultAgentAccess, "coarse")) {
      return c.json({ error: "events are hidden from agents by policy", privacy: "hidden" }, 403);
    }
    const limit = parseLimit(c.req.query("limit"), 50, 500);
    const events = await ctx.eventsStore.listRecent(limit);
    return c.json({ events: isAdmin ? events : events.map(stripPlace) });
  });

  return app;
}
