/**
 * Presence events REST API (plan section 9.7/9.8).
 *   GET /v1/events -> recent presence events (read_presence)
 *
 * Privacy:
 * - Withheld entirely in `hidden` mode.
 * - Non-admin (agent) callers get `agentEventView`: no place names, so the
 *   feed cannot be used as a back-door movement log of named places + exact
 *   times (review findings P4/P5). Admins see full events.
 */

import { Hono } from "hono";
import { accessAtLeast, agentEventView } from "../privacy/policy.js";
import { requireScope } from "./middleware.js";
import { parseLimit } from "./validation.js";
import type { AppEnv } from "./types.js";

export function eventsRouter(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/", requireScope("read_presence"), async (c) => {
    const { scopes } = c.get("principal");
    const scope = c.get("scope");
    const settings = await scope.settings.getOrSeed();
    const isAdmin = scopes.includes("manage_privacy");
    if (!isAdmin && !accessAtLeast(settings.defaultAgentAccess, "coarse")) {
      return c.json({ error: "events are hidden from agents by policy", privacy: "hidden" }, 403);
    }
    const limit = parseLimit(c.req.query("limit"), 50, 500);
    const events = await scope.events.listRecent(limit);
    return c.json({ events: isAdmin ? events : events.map(agentEventView) });
  });

  return app;
}
