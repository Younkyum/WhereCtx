/**
 * Places / geofences REST API (plan section 9.7).
 *   GET    /v1/places        -> list (read_presence or manage_places)
 *   POST   /v1/places        -> create/replace by name (manage_places)
 *   DELETE /v1/places/:name  -> delete (manage_places)
 *
 * Privacy: a place's exact lat/lon is the user's home/work address. Agents
 * (read_presence) get a sanitized list without coordinates; only admins
 * (manage_places) see full place objects.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { RouteContext } from "../app/context.js";
import { DEFAULT_PLACE_RADIUS_M, sanitizePlace } from "../types.js";
import { decide } from "./accessAudit.js";
import { requireAnyScope, requireScope } from "./middleware.js";
import { zodMessages } from "./validation.js";
import type { AppEnv } from "./types.js";

const PlaceSchema = z.object({
  name: z.string().min(1).max(64),
  label: z.string().max(128).optional(),
  // lat/lon are optional when useCurrentLocation is set (server fills them from
  // the current presence — works even at a protected home, since this is an
  // admin action and coordinates are never sent to the client).
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  radiusM: z.number().positive().max(100_000).optional(),
  type: z.enum(["home", "work", "custom"]),
  useCurrentLocation: z.boolean().optional(),
});

export function placesRouter(ctx: RouteContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/", requireAnyScope("read_presence", "manage_places"), async (c) => {
    const places = await c.get("scope").places.list();
    const isAdmin = c.get("principal").scopes.includes("manage_places");
    // Full place objects carry the exact coordinates of home and work.
    decide(c, { precise: isAdmin });
    return c.json({ places: isAdmin ? places : places.map(sanitizePlace) });
  });

  app.post("/", requireScope("manage_places"), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "request body must be valid JSON" }, 400);
    }
    const parsed = PlaceSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid place", detail: zodMessages(parsed.error) }, 400);
    }
    const d = parsed.data;
    const scope = c.get("scope");
    let { lat, lon } = d;
    if (d.useCurrentLocation) {
      const current = await scope.presence.getCurrent();
      if (!current?.precise) {
        return c.json({ error: "no current location available to use" }, 400);
      }
      lat = current.precise.lat;
      lon = current.precise.lon;
    }
    if (lat === undefined || lon === undefined) {
      return c.json({ error: "lat/lon are required (or set useCurrentLocation)" }, 400);
    }
    const place = await scope.places.upsert({
      name: d.name,
      label: d.label,
      type: d.type,
      lat,
      lon,
      radiusM: d.radiusM ?? DEFAULT_PLACE_RADIUS_M,
    });
    // Status is frozen at ingest time; adding/moving a place can change the
    // current geofence verdict, so re-evaluate against the last known location
    // and dispatch any resulting events. Without this, registering "work" while
    // standing at work still shows "away" until the next reading arrives.
    const result = await scope.presence.reevaluateCurrent();
    if (result) await ctx.onEvents?.(result.events);
    return c.json({ place }, 201);
  });

  app.delete("/:name", requireScope("manage_places"), async (c) => {
    const name = c.req.param("name");
    const scope = c.get("scope");
    const deleted = await scope.places.deleteByName(name);
    if (!deleted) return c.json({ error: "place not found" }, 404);
    // Removing a place can flip the current status (e.g. work -> away); keep the
    // displayed status consistent without waiting for the next reading.
    const result = await scope.presence.reevaluateCurrent();
    if (result) await ctx.onEvents?.(result.events);
    return c.json({ ok: true });
  });

  return app;
}
