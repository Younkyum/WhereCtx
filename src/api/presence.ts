/**
 * Presence REST API (plan section 9.7).
 *   GET /v1/presence            -> coarse presence (read_presence)
 *   GET /v1/presence/precise    -> precise location, policy-gated (read_precise_location)
 *   GET /v1/presence/history?from=&to=&limit=
 *                               -> raw history in [from, to] (default: the last
 *                                  24 hours, and 5 minutes ahead for clock skew),
 *                                  the newest `limit` points, oldest first,
 *                                  manage_privacy, no-store
 *
 * Reads lazily run a stale check so `presence.became_stale` fires without a
 * separate scheduler (it is also swept periodically in Phase 4).
 */

import { Hono, type MiddlewareHandler } from "hono";
import type { RouteContext } from "../app/context.js";
import { authorizePrecise, buildPreciseView } from "../privacy/policy.js";
import { toPresenceContext } from "../store/presenceStore.js";
import { haversineMeters } from "../geofence/distance.js";
import type { Place } from "../types.js";
import { decide, refuse } from "./accessAudit.js";
import { noStore, requireScope } from "./middleware.js";
import { parseLimit } from "./validation.js";
import { z } from "zod";
import { HISTORY_DEFAULT_POINTS, HISTORY_MAX_POINTS } from "../types.js";
import type { AppEnv } from "./types.js";

const DAY_MS = 86_400_000;
/** A phone whose clock runs a little fast still has its newest points in the default range. */
const FUTURE_SKEW_MS = 5 * 60_000;

/** ISO 8601 with a time and an offset (Z or ±hh:mm), nothing looser. */
const HistoryRange = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

/** The name of the nearest place whose geofence holds the point, if any. */
export function placeContaining(point: { lat: number; lon: number }, places: readonly Place[]): string | undefined {
  let best: { name: string; d: number } | undefined;
  for (const place of places) {
    const d = haversineMeters(point.lat, point.lon, place.lat, place.lon);
    if (d <= place.radiusM && (!best || d < best.d)) best = { name: place.name, d };
  }
  return best?.name;
}

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

    const view = ctx.views.agentCoarse(toPresenceContext(stored), settings);
    if (view && c.get("principal").via === "session") {
      // The owner in the dashboard sees their own area whether or not agents may.
      return c.json(ctx.views.ownerCoarse(toPresenceContext(stored), settings));
    }
    if (!view) {
      decide(c, { outcome: "hidden" });
      return c.json({ error: "presence is hidden from agents by policy", privacy: "hidden" }, 403);
    }
    return c.json(view);
  });

  // Precise location, gated by the privacy engine. Marked precise before the
  // scope check, so a refusal is logged with the reason the agent gave.
  const preciseRequest: MiddlewareHandler<AppEnv> = async (c, next) => {
    decide(c, { precise: true, reason: c.req.query("reason") });
    await next();
  };
  app.get("/precise", preciseRequest, requireScope("read_precise_location"), async (c) => {
    const { scopes } = c.get("principal");
    const scope = c.get("scope");
    const reason = c.req.query("reason");
    if (reason !== undefined && reason.length > 256) return refuse(c, 400, "reason too long (max 256 chars)");
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
      decide(c, auth.outcome === "hidden" ? { outcome: "hidden" } : { outcome: "denied", denial: `precise location denied: ${auth.reason}` });
      return c.json({ error: "precise location denied", detail: auth.reason }, 403);
    }
    const view = buildPreciseView(presence, ctx.clock);
    if (!view) return c.json({ error: "no precise location available" }, 404);
    return c.json(view);
  });

  // Raw history: empty unless the person turned on storeRawHistory. Each point
  // names the place it fell inside, by the places as they are now.
  const historyRequest: MiddlewareHandler<AppEnv> = async (c, next) => {
    decide(c, { precise: true });
    await next();
  };
  app.get("/history", historyRequest, requireScope("manage_privacy"), noStore, async (c) => {
    const range = HistoryRange.safeParse({ from: c.req.query("from"), to: c.req.query("to") });
    if (!range.success) {
      return c.json({ error: "from and to must be ISO 8601 date-times with an offset, like 2026-10-18T09:00:00Z" }, 400);
    }
    const now = ctx.clock().getTime();
    const to = range.data.to ? new Date(range.data.to) : new Date(now + FUTURE_SKEW_MS);
    const from = range.data.from ? new Date(range.data.from) : new Date(now - DAY_MS);
    if (from > to) return c.json({ error: "from must not be after to" }, 400);
    const limit = parseLimit(c.req.query("limit"), HISTORY_DEFAULT_POINTS, HISTORY_MAX_POINTS);
    const scope = c.get("scope");
    const [stored, places, settings] = await Promise.all([
      scope.history.listRange({ from: from.toISOString(), to: to.toISOString(), limit }),
      scope.places.list(),
      scope.settings.getOrSeed(),
    ]);
    return c.json({
      enabled: settings.storeRawHistory,
      retentionHours: settings.retentionHours,
      from: from.toISOString(),
      to: to.toISOString(),
      truncated: stored.truncated,
      points: stored.points.map((p) => {
        const place = placeContaining(p, places);
        return place ? { ...p, place } : p;
      }),
    });
  });

  return app;
}
