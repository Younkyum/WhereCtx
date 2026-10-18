/**
 * Presence REST API (plan section 9.7).
 *   GET /v1/presence            -> coarse presence (read_presence)
 *   GET /v1/presence/precise    -> precise location, policy-gated (read_precise_location)
 *   GET /v1/presence/history?from=&to=&limit=
 *                               -> raw history in [from, to] (default: the last
 *                                  24 hours), oldest first, manage_privacy, no-store
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
import { haversineMeters } from "../geofence/distance.js";
import type { Place } from "../types.js";
import { noStore, requireScope } from "./middleware.js";
import { parseLimit } from "./validation.js";
import type { AppEnv } from "./types.js";

const DAY_MS = 86_400_000;
const HISTORY_MAX_POINTS = 5000;

/** undefined when absent; an invalid date when present but unreadable. */
function parseInstant(raw: string | undefined): Date | undefined {
  return raw ? new Date(raw) : undefined;
}

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

  // Raw history: empty unless the person turned on storeRawHistory. Each point
  // names the place it fell inside, by the places as they are now.
  app.get("/history", requireScope("manage_privacy"), noStore, async (c) => {
    const to = parseInstant(c.req.query("to")) ?? ctx.clock();
    const from = parseInstant(c.req.query("from")) ?? new Date(to.getTime() - DAY_MS);
    if (Number.isNaN(to.getTime()) || Number.isNaN(from.getTime())) {
      return c.json({ error: "from and to must be ISO 8601 timestamps" }, 400);
    }
    if (from > to) return c.json({ error: "from must not be after to" }, 400);
    const limit = parseLimit(c.req.query("limit"), 1000, HISTORY_MAX_POINTS);
    const scope = c.get("scope");
    const [range, places, settings] = await Promise.all([
      scope.history.listRange({ from: from.toISOString(), to: to.toISOString(), limit }),
      scope.places.list(),
      scope.settings.getOrSeed(),
    ]);
    return c.json({
      enabled: settings.storeRawHistory,
      retentionHours: settings.retentionHours,
      from: from.toISOString(),
      to: to.toISOString(),
      truncated: range.truncated,
      points: range.points.map((p) => {
        const place = placeContaining(p, places);
        return place ? { ...p, place } : p;
      }),
    });
  });

  return app;
}
