/**
 * MCP server exposing WhereCtx presence to AI agents (plan section 9.6).
 *
 * A fresh McpServer is built per request (stateless transport) and carries the
 * authenticated token so every tool re-applies the same privacy/scope rules the
 * REST surface enforces: hidden mode withholds, precise is policy-gated, home
 * coordinates are protected, and raw coordinates never leak through coarse tools.
 *
 * Tools (plan section 9.6):
 *   get_presence, get_precise_location, is_near_place, list_places,
 *   get_location_age, list_recent_presence_events, create_location_reminder
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppContext } from "../app/context.js";
import type { VerifiedToken } from "../auth/tokens.js";
import { haversineMeters } from "../geofence/distance.js";
import {
  accessAtLeast,
  agentCoarseView,
  authorizePrecise,
  buildPreciseView,
} from "../privacy/policy.js";
import { toPresenceContext } from "../store/presenceStore.js";
import { secondsSince, isStale } from "../util/time.js";

/** Cap on active location reminders, to bound writes from read-scoped tokens. */
const MAX_ACTIVE_REMINDERS = 100;

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});
const err = (message: string) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
  isError: true,
});

export function buildMcpServer(ctx: AppContext, token: VerifiedToken): McpServer {
  const server = new McpServer(
    { name: "wherectx", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  const userId = ctx.config.userId;
  const isAdmin = token.scopes.includes("manage_privacy");

  // Whether the caller may see presence at all under the live policy.
  const presenceVisible = async (): Promise<boolean> => {
    if (isAdmin) return true;
    const settings = await ctx.settings.get(userId);
    return !!settings && accessAtLeast(settings.defaultAgentAccess, "coarse");
  };

  server.registerTool(
    "get_presence",
    {
      description:
        "Get the user's current coarse presence (status, label, motion, age, stale flag). No raw GPS. Returns hidden if policy withholds presence.",
      inputSchema: {},
    },
    async () => {
      const stored = await ctx.presenceStore.getCurrent(userId);
      if (!stored) return ok({ status: "unknown", note: "no presence recorded yet" });
      const settings = await ctx.settings.get(userId);
      if (!settings) return err("privacy settings not initialized");
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
      const stored = await ctx.presenceStore.getCurrent(userId);
      if (!stored) return err("no presence recorded yet");
      const settings = await ctx.settings.get(userId);
      if (!settings) return err("privacy settings not initialized");
      const presence = toPresenceContext(stored);
      const auth = authorizePrecise({ scopes: token.scopes, settings, presence, reason });
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
      const place = await ctx.placesStore.get(userId, name);
      if (!place) return err(`no place named "${name}"`);
      const stored = await ctx.presenceStore.getCurrent(userId);
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
        "List the user's registered place names and types (no coordinates). Admin tokens additionally receive coordinates and radius.",
      inputSchema: {},
    },
    async () => {
      const places = await ctx.placesStore.list(userId);
      if (isAdmin) return ok({ places });
      return ok({ places: places.map((p) => ({ name: p.name, type: p.type })) });
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
      const stored = await ctx.presenceStore.getCurrent(userId);
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
      const events = await ctx.eventsStore.listRecent(limit ?? 20);
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
      const target = await ctx.placesStore.get(userId, place);
      if (!target) return err(`no place named "${place}"`);
      // ...and cap total active reminders so a read-scoped token cannot exhaust
      // storage (review finding M2).
      if ((await ctx.remindersStore.countActive()) >= MAX_ACTIVE_REMINDERS) {
        return err(`reminder limit reached (${MAX_ACTIVE_REMINDERS} active)`);
      }
      const reminder = await ctx.remindersStore.create(place, message);
      return ok({ id: reminder.id, place: reminder.placeName, message: reminder.message });
    },
  );

  return server;
}
