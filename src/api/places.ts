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
import type { AppContext } from "../app/context.js";
import type { Place } from "../types.js";
import { bearerAuth, requireAnyScope, requireScope } from "./middleware.js";
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

const DEFAULT_RADIUS_M = 150;

/**
 * Agent-facing place view: name + type only. We deliberately omit lat/lon (the
 * home address), and also radiusM/label/timestamps — radiusM leaks the geofence
 * size and label is often the literal address the operator typed (review P6).
 * Agents that need "am I near X?" use the geofence via MCP, not coordinates.
 */
function sanitize(place: Place): { name: string; type: Place["type"] } {
  return { name: place.name, type: place.type };
}

export function placesRouter(ctx: AppContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", bearerAuth(ctx));

  const userId = ctx.config.userId;

  app.get("/", requireAnyScope("read_presence", "manage_places"), async (c) => {
    const places = await ctx.placesStore.list(userId);
    const isAdmin = c.get("token").scopes.includes("manage_places");
    return c.json({ places: isAdmin ? places : places.map(sanitize) });
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
    let { lat, lon } = d;
    if (d.useCurrentLocation) {
      const current = await ctx.presenceStore.getCurrent(userId);
      if (!current?.precise) {
        return c.json({ error: "no current location available to use" }, 400);
      }
      lat = current.precise.lat;
      lon = current.precise.lon;
    }
    if (lat === undefined || lon === undefined) {
      return c.json({ error: "lat/lon are required (or set useCurrentLocation)" }, 400);
    }
    const place = await ctx.placesStore.upsert(userId, {
      name: d.name,
      label: d.label,
      type: d.type,
      lat,
      lon,
      radiusM: d.radiusM ?? DEFAULT_RADIUS_M,
    });
    return c.json({ place }, 201);
  });

  app.delete("/:name", requireScope("manage_places"), async (c) => {
    const name = c.req.param("name");
    const deleted = await ctx.placesStore.deleteByName(userId, name);
    if (!deleted) return c.json({ error: "place not found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}
