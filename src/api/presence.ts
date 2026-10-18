/**
 * Presence REST API (plan section 9.7).
 *   GET /v1/presence            -> coarse presence (read_presence)
 *   GET /v1/presence/precise    -> precise location, policy-gated (read_precise_location)
 *   GET /v1/presence/history    -> raw history, admin only (manage_privacy)
 *
 * Reads lazily run a stale check so `presence.became_stale` fires without a
 * separate scheduler (it is also swept periodically in Phase 4).
 */

import { Hono } from "hono";
import type { RouteContext } from "../app/context.js";
import {
  agentCoarseView,
  authorizePrecise,
  buildPreciseView,
} from "../privacy/policy.js";
import { toPresenceContext } from "../store/presenceStore.js";
import { requireScope } from "./middleware.js";
import { parseLimit } from "./validation.js";
import type { AppEnv } from "./types.js";

export function presenceRouter(ctx: RouteContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Current coarse presence.
  app.get("/", requireScope("read_presence"), async (c) => {
    const scope = c.get("scope");
    const staleEvent = await scope.presence.checkStale();
    if (staleEvent) await ctx.onEvents?.([staleEvent]);

    const stored = await scope.presence.getCurrent();
    if (!stored) return c.json({ error: "no presence recorded yet" }, 404);
    const settings = await scope.settings.getOrSeed();

    const view = agentCoarseView(toPresenceContext(stored), settings, ctx.clock);
    if (!view) {
      return c.json({ error: "presence is hidden from agents by policy", privacy: "hidden" }, 403);
    }
    return c.json(view);
  });

  // Precise location, gated by the privacy engine.
  app.get("/precise", requireScope("read_precise_location"), async (c) => {
    const { scopes } = c.get("principal");
    const scope = c.get("scope");
    const rawReason = c.req.query("reason");
    if (rawReason !== undefined && rawReason.length > 256) {
      return c.json({ error: "reason too long (max 256 chars)" }, 400);
    }
    const reason = rawReason;
    const stored = await scope.presence.getCurrent();
    if (!stored) return c.json({ error: "no presence recorded yet" }, 404);
    const settings = await scope.settings.getOrSeed();

    const presence = toPresenceContext(stored);
    const auth = authorizePrecise({
      scopes,
      settings,
      presence,
      reason,
    });
    if (!auth.allowed) {
      return c.json({ error: "precise location denied", detail: auth.reason }, 403);
    }
    const view = buildPreciseView(presence, ctx.clock);
    if (!view) return c.json({ error: "no precise location available" }, 404);
    return c.json(view);
  });

  // Raw history (admin only; empty unless STORE_RAW_HISTORY is enabled).
  app.get("/history", requireScope("manage_privacy"), async (c) => {
    const limit = parseLimit(c.req.query("limit"), 100, 1000);
    const points = await c.get("scope").history.listRecent(limit);
    return c.json({ points });
  });

  return app;
}
