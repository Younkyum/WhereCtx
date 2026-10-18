/**
 * MCP server exposing WhereCtx presence to AI agents (plan section 9.6).
 *
 * A fresh McpServer is built per request (stateless transport) and carries the
 * caller's principal and user scope. Every read and write goes through that
 * scope, so it is bound to the credential's owner, and
 * every tool re-applies the same privacy/scope rules the REST surface enforces:
 * hidden mode withholds, precise is policy-gated, home coordinates are
 * protected, and raw coordinates never leak through coarse tools.
 *
 * Tools (plan section 9.6):
 *   get_presence, get_precise_location, is_near_place, list_places,
 *   get_location_age, list_recent_presence_events, create_location_reminder
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RouteContext, UserScope } from "../app/context.js";
import type { Principal } from "../auth/principal.js";
import { haversineMeters } from "../geofence/distance.js";
import {
  accessAtLeast,
  agentCoarseView,
  authorizePrecise,
  buildPreciseView,
} from "../privacy/policy.js";
import { toPresenceContext } from "../store/presenceStore.js";
import { DEFAULT_PLACE_RADIUS_M, sanitizePlace, type PlaceType } from "../types.js";
import { secondsSince, isStale } from "../util/time.js";

/** Cap on active location reminders, to bound writes from read-scoped tokens. */
const MAX_ACTIVE_REMINDERS = 100;

/** Cap on registered places, to bound writes from read-scoped tokens. */
const MAX_PLACES = 100;

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});
const err = (message: string) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
  isError: true,
});

export function buildMcpServer(
  scope: UserScope,
  principal: Principal,
  ctx: RouteContext,
): McpServer {
  const server = new McpServer(
    { name: "wherectx", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  const isAdmin = principal.scopes.includes("manage_privacy");
  // Same scope REST places uses to decide who sees place coordinates.
  const canManagePlaces = principal.scopes.includes("manage_places");

  // Whether the caller may see presence at all under the live policy.
  const presenceVisible = async (): Promise<boolean> => {
    if (isAdmin) return true;
    const settings = await scope.settings.getOrSeed();
    return accessAtLeast(settings.defaultAgentAccess, "coarse");
  };

  server.registerTool(
    "get_presence",
    {
      description:
        "Get the user's current coarse presence (status, label, motion, age, stale flag). No raw GPS. Returns hidden if policy withholds presence.",
      inputSchema: {},
    },
    async () => {
      const stored = await scope.presence.getCurrent();
      if (!stored) return ok({ status: "unknown", note: "no presence recorded yet" });
      const settings = await scope.settings.getOrSeed();
      if (!isAdmin) {
        const view = agentCoarseView(toPresenceContext(stored), settings, ctx.clock);
        if (!view) return ok({ status: "hidden", privacy: "hidden" });
        return ok(view);
      }
      // Admin sees the coarse summary using the live mode.
      const view = agentCoarseView(toPresenceContext(stored), { ...settings, defaultAgentAccess: "coarse" }, ctx.clock);
      return ok(view);
    },
  );

  server.registerTool(
    "get_precise_location",
    {
      description:
        "Get the user's precise GPS location and a map link. Requires a reason and is denied by policy unless precise access is allowed and the user is not at a protected home location.",
      inputSchema: { reason: z.string().min(1).max(256).describe("Why precise location is needed") },
    },
    async ({ reason }) => {
      const stored = await scope.presence.getCurrent();
      if (!stored) return err("no presence recorded yet");
      const settings = await scope.settings.getOrSeed();
      const presence = toPresenceContext(stored);
      const auth = authorizePrecise({ scopes: principal.scopes, settings, presence, reason });
      if (!auth.allowed) return err(auth.reason ?? "precise location denied");
      const view = buildPreciseView(presence, ctx.clock);
      if (!view) return err("no precise location available");
      return ok(view);
    },
  );

  server.registerTool(
    "is_near_place",
    {
      description:
        "Check whether the user is currently inside or near a registered place by name (e.g. 'home', 'work'). Returns booleans only — never coordinates.",
      inputSchema: { name: z.string().min(1).max(64).describe("The place name to check") },
    },
    async ({ name }) => {
      if (!(await presenceVisible())) return ok({ name, hidden: true });
      const place = await scope.places.get(name);
      if (!place) return err(`no place named "${name}"`);
      const stored = await scope.presence.getCurrent();
      if (!stored?.precise) return ok({ name, near: false, inside: false, note: "no location" });
      const d = haversineMeters(
        stored.precise.lat,
        stored.precise.lon,
        place.lat,
        place.lon,
      );
      const inside = d <= place.radiusM;
      const near = d <= place.radiusM * ctx.config.geofence.nearRadiusMultiplier;
      return ok({ name, inside, near });
    },
  );

  server.registerTool(
    "list_places",
    {
      description:
        "List the user's registered place names and types (no coordinates). Tokens that can manage places additionally receive coordinates and radius.",
      inputSchema: {},
    },
    async () => {
      const places = await scope.places.list();
      if (canManagePlaces) return ok({ places });
      return ok({ places: places.map(sanitizePlace) });
    },
  );

  server.registerTool(
    "get_location_age",
    {
      description:
        "How long ago the user's location was last updated, and whether it is stale. Useful before trusting presence.",
      inputSchema: {},
    },
    async () => {
      if (!(await presenceVisible())) return ok({ hidden: true });
      const stored = await scope.presence.getCurrent();
      if (!stored) return ok({ note: "no presence recorded yet" });
      return ok({
        updatedAgoSec: secondsSince(stored.updatedAt, ctx.clock),
        stale: isStale(stored.updatedAt, stored.staleAfterSec, ctx.clock),
        updatedAt: stored.updatedAt,
      });
    },
  );

  server.registerTool(
    "list_recent_presence_events",
    {
      description:
        "List recent presence events (updated / entered_place / left_place / became_stale / privacy_changed). Place names are omitted for non-admin tokens.",
      inputSchema: { limit: z.number().int().min(1).max(200).optional() },
    },
    async ({ limit }) => {
      if (!(await presenceVisible())) return ok({ hidden: true, events: [] });
      const events = await scope.events.listRecent(limit ?? 20);
      if (isAdmin) return ok({ events });
      return ok({ events: events.map(({ placeName: _p, ...rest }) => rest) });
    },
  );

  server.registerTool(
    "create_location_reminder",
    {
      description:
        "Create a reminder that fires when the user next enters the named place. Returns the reminder id.",
      inputSchema: {
        place: z.string().min(1).max(64).describe("Place name to trigger on"),
        message: z.string().min(1).max(500).describe("Reminder message"),
      },
    },
    async ({ place, message }) => {
      // Re-apply the same gates as the read tools: withhold in hidden mode...
      if (!(await presenceVisible())) return err("presence is hidden from agents by policy");
      // ...require the target place to actually exist (no name probing / dangling
      // reminders)...
      const target = await scope.places.get(place);
      if (!target) return err(`no place named "${place}"`);
      // ...and cap total active reminders so a read-scoped token cannot exhaust
      // storage (review finding M2).
      if ((await scope.reminders.countActive()) >= MAX_ACTIVE_REMINDERS) {
        return err(`reminder limit reached (${MAX_ACTIVE_REMINDERS} active)`);
      }
      const reminder = await scope.reminders.create(place, message);
      return ok({ id: reminder.id, place: reminder.placeName, message: reminder.message });
    },
  );

  const placeType = z.enum(["home", "work", "custom"]);

  /**
   * Home-place protection gate for agent place-writes (dashboard toggle,
   * `protectHomePlace`, default ON). When protection is on, a token without
   * `manage_places` may neither create a `home`-typed place nor touch an
   * existing place whose stored type is `home` — otherwise an agent could move
   * the home geofence and mislead the home-coordinate privacy protections.
   * Returns an error message or null.
   */
  const homeWriteDenied = async (
    name: string,
    requestedType: PlaceType,
  ): Promise<string | null> => {
    if (canManagePlaces) return null;
    if (!(await scope.settings.getOrSeed()).protectHomePlace) return null;
    if (requestedType === "home") {
      return "creating or changing a 'home' place requires the manage_places scope (home place protection is enabled)";
    }
    const existing = await scope.places.get(name);
    if (existing?.type === "home") {
      return `place "${name}" is the protected home place; modifying it requires the manage_places scope`;
    }
    return null;
  };

  server.registerTool(
    "create_place",
    {
      description:
        "Register a place / geofence at explicit coordinates. type is home, work, or custom; radiusM defaults to 150m. Creating or changing a 'home' place may require an admin token when home place protection is enabled.",
      inputSchema: {
        name: z.string().min(1).max(64).describe("Place name, e.g. 'gym'"),
        type: placeType.describe("home | work | custom"),
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
        radiusM: z.number().positive().max(100_000).optional().describe("Geofence radius in meters (default 150)"),
      },
    },
    async ({ name, type, lat, lon, radiusM }) => {
      const denied = await homeWriteDenied(name, type);
      if (denied) return err(denied);
      if ((await scope.places.count()) >= MAX_PLACES) {
        return err(`place limit reached (${MAX_PLACES})`);
      }
      const place = await scope.places.upsert({
        name,
        type,
        lat,
        lon,
        radiusM: radiusM ?? DEFAULT_PLACE_RADIUS_M,
      });
      // Same as the REST surface: a new/moved place can change the current
      // geofence verdict, so re-evaluate against the last known location and
      // dispatch any resulting events (commit bd529b2 parity).
      const result = await scope.presence.reevaluateCurrent();
      if (result) await ctx.onEvents?.(result.events);
      return ok({ name: place.name, type: place.type, radiusM: place.radiusM });
    },
  );

  server.registerTool(
    "remember_current_place",
    {
      description:
        "Register the user's CURRENT location as a place / geofence under the given name. Uses the last known location server-side; coordinates are not returned. Refused if there is no recent location. Remembering a 'home' place may require an admin token when home place protection is enabled.",
      inputSchema: {
        name: z.string().min(1).max(64).describe("Name for this place, e.g. 'gym'"),
        type: placeType.optional().describe("home | work | custom (default custom)"),
        radiusM: z.number().positive().max(100_000).optional().describe("Geofence radius in meters (default 150)"),
      },
    },
    async ({ name, type, radiusM }) => {
      const denied = await homeWriteDenied(name, type ?? "custom");
      if (denied) return err(denied);
      if ((await scope.places.count()) >= MAX_PLACES) {
        return err(`place limit reached (${MAX_PLACES})`);
      }
      const current = await scope.presence.getCurrent();
      if (!current?.precise) return err("no current location available to remember");
      const place = await scope.places.upsert({
        name,
        type: type ?? "custom",
        lat: current.precise.lat,
        lon: current.precise.lon,
        radiusM: radiusM ?? DEFAULT_PLACE_RADIUS_M,
      });
      // Same as the REST surface: a new/moved place can change the current
      // geofence verdict, so re-evaluate against the last known location and
      // dispatch any resulting events (commit bd529b2 parity).
      const result = await scope.presence.reevaluateCurrent();
      if (result) await ctx.onEvents?.(result.events);
      return ok({ name: place.name, type: place.type, radiusM: place.radiusM });
    },
  );

  return server;
}
