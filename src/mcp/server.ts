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
 *   get_location_age, list_recent_presence_events, create_location_reminder,
 *   create_place, remember_current_place, get_eta, get_directions
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RouteContext, UserScope } from "../app/context.js";
import type { McpPrincipal } from "../auth/principal.js";
import { measurePlace } from "../geofence/shape.js";
import {
  accessAtLeast,
  agentEventView,
  authorizePrecise,
  buildPreciseView,
} from "../privacy/policy.js";
import { dwellOf, toPresenceContext, type StoredPresence } from "../store/presenceStore.js";
import { pendingTransition } from "../geofence/dwell.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import { accessRecorder, type AccessRecorder } from "../activity/record.js";
import type { AccessAction, AccessDecision } from "../activity/types.js";
import { DEFAULT_PLACE_RADIUS_M, sanitizePlace, type Place, type PlaceType } from "../types.js";
import { credentialOf } from "../activity/record.js";
import type { AgentCaller } from "../geo/service.js";
import { candidateViews, pickCandidate } from "../geo/service.js";
import { etaReply, numbered, searchReply } from "../geo/replies.js";
import { ROUTE_AVOID } from "../geo/types.js";

/** Cap on active location reminders, to bound writes from read-scoped tokens. */
const MAX_ACTIVE_REMINDERS = 100;

/** Cap on registered places, to bound writes from read-scoped tokens. */
const MAX_PLACES = 100;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/**
 * A tool's answer together with its access decision, so every tool says what
 * became of the call and the recorder never reads the answer back.
 */
interface Reply {
  decision: AccessDecision;
  body: unknown;
  isError?: boolean;
}

/** Served. `precise` when the answer carries coordinates. */
const ok = (body: unknown, precise = false): Reply => ({
  decision: { outcome: "allowed", ...(precise ? { precise } : {}) },
  body,
});
/** Withheld by hidden mode. */
const hidden = (body: unknown): Reply => ({ decision: { outcome: "hidden" }, body });
/** Refused by scope or policy. */
const err = (message: string, precise = false): Reply => ({
  decision: { outcome: "denied", denial: message, ...(precise ? { precise } : {}) },
  body: { error: message },
  isError: true,
});
/** Nothing to answer with (no presence yet, no such place): served, as a REST 404 is. */
const none = (message: string, precise = false): Reply => ({
  decision: { outcome: "allowed", ...(precise ? { precise } : {}) },
  body: { error: message },
  isError: true,
});

const toResult = (reply: Reply): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(reply.body) }],
  ...(reply.isError ? { isError: true } : {}),
});

/**
 * Write one access log row per tools/call request, valid or not, when its
 * response goes out. Watches the transport the server connects to: its
 * incoming requests and its outgoing responses. A call still unanswered when
 * the transport closes is recorded as an error.
 */
function recordToolCalls(
  server: McpServer,
  record: AccessRecorder,
  outcomeOf: (id: RequestId, name: string, undecided: AccessDecision) => { action: AccessAction; decision: AccessDecision },
): void {
  const pending = new Map<RequestId, { name: string; args: unknown }>();
  /** `undecided`: the outcome of a call no handler decided (the SDK refused it, or it was never answered). */
  const settle = async (id: RequestId, undecided: AccessDecision): Promise<void> => {
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    const { action, decision } = outcomeOf(id, call.name, undecided);
    const reason = (call.args as { reason?: unknown } | undefined)?.reason;
    await record({
      action,
      ...decision,
      ...(decision.precise && typeof reason === "string" ? { reason } : {}),
    });
  };
  const connect = server.connect.bind(server);
  server.connect = (transport: Transport) => {
    // Protocol.connect chains these, so they run before the server's own.
    transport.onmessage = (message) => {
      if (isJSONRPCRequest(message) && message.method === "tools/call") {
        const params = message.params as { name?: unknown; arguments?: unknown } | undefined;
        pending.set(message.id, { name: typeof params?.name === "string" ? params.name : "", args: params?.arguments });
      }
    };
    transport.onclose = () => {
      for (const id of [...pending.keys()]) void settle(id, { outcome: "error" });
    };
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
        if (message.id !== undefined && message.id !== null) {
          await settle(message.id, { outcome: "denied", denial: "invalid arguments" });
        }
      }
      return send(message, options);
    };
    return connect(transport);
  };
}

/**
 * An enter or leave waiting out its dwell time, as an agent may see it: the
 * kind, the place's type and how long it has been pending; never its name.
 */
function transitionOf(
  stored: StoredPresence,
  places: readonly Place[],
  now: Date,
): { kind: "entering" | "leaving"; placeType: PlaceType; forSec: number } | undefined {
  const pending = pendingTransition(dwellOf(stored));
  const place = pending && places.find((p) => p.name === pending.name);
  if (!pending || !place) return undefined;
  return {
    kind: pending.kind,
    placeType: place.type,
    forSec: Math.max(0, Math.floor((now.getTime() - Date.parse(pending.since)) / 1000)),
  };
}

export function buildMcpServer(
  scope: UserScope,
  principal: McpPrincipal,
  ctx: RouteContext,
): McpServer {
  const server = new McpServer(
    { name: "wherectx", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // Every tool is registered through this wrapper, which keeps the decision
  // its handler returned for the call's request id. The access log is written
  // per tools/call request (recordToolCalls), so a call the SDK refuses before
  // any handler runs (bad arguments, an unknown tool) is recorded too.
  const decisions = new Map<RequestId, AccessDecision>();
  const tools = new Set<string>();
  const registerTool = <Shape extends z.ZodRawShape>(
    name: AccessAction,
    config: { description: string; inputSchema: Shape },
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<Reply>,
  ): void => {
    tools.add(name);
    const run = async (args: z.infer<z.ZodObject<Shape>>, extra: { requestId: RequestId }): Promise<ToolResult> => {
      let reply: Reply;
      try {
        reply = await handler(args);
      } catch (e) {
        decisions.set(extra.requestId, { outcome: "error" });
        throw e;
      }
      decisions.set(extra.requestId, reply.decision);
      return toResult(reply);
    };
    server.registerTool(name, config, run as never);
  };
  recordToolCalls(server, accessRecorder(scope, principal, "mcp"), (id, name, undecided) => {
    const decision = decisions.get(id);
    decisions.delete(id);
    if (!tools.has(name)) return { action: "unknown", decision: { outcome: "denied", denial: "unknown tool" } };
    return { action: name as AccessAction, decision: decision ?? undecided };
  });

  const isAdmin = principal.scopes.includes("manage_privacy");
  // Same scope REST places uses to decide who sees place coordinates.
  const canManagePlaces = principal.scopes.includes("manage_places");

  // Whether the caller may see presence at all under the live policy.
  const presenceVisible = async (): Promise<boolean> => {
    if (isAdmin) return true;
    const settings = await scope.settings.getOrSeed();
    return accessAtLeast(settings.defaultAgentAccess, "coarse");
  };

  registerTool(
    "get_presence",
    {
      description:
        "Get the user's current coarse presence: status, label, motion, freshness, seconds since the last report and since they last moved, and the neighbourhood when the user allows it. No raw GPS. Returns hidden if policy withholds presence. Status follows the confirmed place: a place can ask for a few minutes inside before an arrival counts, or outside before a departure counts; while one is waiting, transition says entering or leaving, the place type, and for how many seconds. freshness says how far to trust it: 'live' (reported recently, not at rest), 'stationary' (at rest; the phone reports only when it moves, so a quiet phone is normal: treat as still at the last place), 'offline' (the phone has sent nothing for far longer than a phone at rest stays quiet), 'unknown' (the phone went quiet while on the move, or an old manual or Shortcut reading). stale is true for offline and for an old manual or Shortcut reading.",
      inputSchema: {},
    },
    async () => {
      const stored = await scope.presence.getCurrent();
      if (!stored) return ok({ status: "unknown", note: "no presence recorded yet" });
      const settings = await scope.settings.getOrSeed();
      // Admin sees the coarse summary using the live mode.
      const view = ctx.views.agentCoarse(
        toPresenceContext(stored),
        isAdmin ? { ...settings, defaultAgentAccess: "coarse" } : settings,
      );
      if (!view) return hidden({ status: "hidden", privacy: "hidden" });
      const transition = transitionOf(stored, await scope.places.list(), ctx.clock());
      return ok(transition ? { ...view, transition } : view);
    },
  );

  registerTool(
    "get_precise_location",
    {
      description:
        "Get the user's precise GPS location and a map link. Requires a reason and is denied by policy unless precise access is allowed and the user is not at a protected home location.",
      inputSchema: { reason: z.string().min(1).max(256).describe("Why precise location is needed") },
    },
    async ({ reason }) => {
      const stored = await scope.presence.getCurrent();
      if (!stored) return none("no presence recorded yet", true);
      const settings = await scope.settings.getOrSeed();
      const presence = toPresenceContext(stored);
      const auth = authorizePrecise({ scopes: principal.scopes, settings, presence, reason });
      if (!auth.allowed) {
        return auth.outcome === "hidden"
          ? { decision: { outcome: "hidden", precise: true }, body: { error: auth.reason }, isError: true }
          : err(auth.reason, true);
      }
      const view = buildPreciseView(presence, ctx.clock);
      if (!view) return none("no precise location available", true);
      return ok(view, true);
    },
  );

  registerTool(
    "is_near_place",
    {
      description:
        "Check whether the user is inside or near a registered place by name (e.g. 'home', 'work'), as of their last report, with that report's freshness. Returns booleans only, never coordinates. A 'stationary' freshness means they are still there. inside is where the last report is; confirmed is whether the user's presence counts them at this place (a place can ask for a few minutes inside before an arrival counts, or outside before a departure counts), and pending says 'entering' or 'leaving' while that wait is on (both are given when the place has such a wait, or when confirmed differs from inside).",
      inputSchema: { name: z.string().min(1).max(64).describe("The place name to check") },
    },
    async ({ name }) => {
      if (!(await presenceVisible())) return hidden({ name, hidden: true });
      const place = await scope.places.get(name);
      if (!place) return none(`no place named "${name}"`);
      const stored = await scope.presence.getCurrent();
      if (!stored?.precise) return ok({ name, near: false, inside: false, note: "no location" });
      const { inside, near } = measurePlace(
        place,
        stored.precise.lat,
        stored.precise.lon,
        ctx.config.geofence.nearRadiusMultiplier,
      );
      const dwell = dwellOf(stored);
      const transition = pendingTransition(dwell);
      const pending = transition?.name === name ? transition.kind : dwell.candidate?.name === name ? "entering" : null;
      const confirmed = dwell.current === name;
      // With no dwell time, confirmed is inside and nothing is ever pending: say so only when it adds something.
      const dwellSet = place.enterAfterSec > 0 || place.exitAfterSec > 0;
      const said = dwellSet || confirmed !== inside || pending !== null ? { confirmed, pending } : {};
      const { freshness, lastReportAgoSec } = ctx.views.freshness(toPresenceContext(stored));
      return ok({ name, inside, near, ...said, freshness, lastReportAgoSec });
    },
  );

  registerTool(
    "list_places",
    {
      description:
        "List the user's registered place names and types (no coordinates). Tokens that can manage places additionally receive coordinates, radius, a polygon place's outline and each place's rules.",
      inputSchema: {},
    },
    async () => {
      const places = await scope.places.list();
      if (canManagePlaces) return ok({ places }, true);
      return ok({ places: places.map(sanitizePlace) });
    },
  );

  registerTool(
    "get_location_age",
    {
      description:
        "How long ago the user's phone last reported and last moved, and how far to trust their presence. Use before relying on presence. freshness says how far to trust it: 'live' (reported recently, not at rest), 'stationary' (at rest; the phone reports only when it moves, so a quiet phone is normal: treat as still at the last place), 'offline' (the phone has sent nothing for far longer than a phone at rest stays quiet), 'unknown' (the phone went quiet while on the move, or an old manual or Shortcut reading). stale is true for offline and for an old manual or Shortcut reading.",
      inputSchema: {},
    },
    async () => {
      if (!(await presenceVisible())) return hidden({ hidden: true });
      const stored = await scope.presence.getCurrent();
      if (!stored) return ok({ note: "no presence recorded yet" });
      const fresh = ctx.views.freshness(toPresenceContext(stored));
      return ok({ updatedAgoSec: fresh.lastReportAgoSec, updatedAt: stored.updatedAt, ...fresh });
    },
  );

  registerTool(
    "list_recent_presence_events",
    {
      description:
        "List recent presence events (updated / entered_place / left_place / approaching_place / became_stale / privacy_changed). entered_place and left_place mark confirmed arrivals and departures; approaching_place fires once as the user heads toward a place that watches for it. Place names are omitted for non-admin tokens.",
      inputSchema: { limit: z.number().int().min(1).max(200).optional() },
    },
    async ({ limit }) => {
      if (!(await presenceVisible())) return hidden({ hidden: true, events: [] });
      const events = await scope.events.listRecent(limit ?? 20);
      if (isAdmin) return ok({ events });
      return ok({ events: events.map(agentEventView) });
    },
  );

  registerTool(
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
      if (!(await presenceVisible())) {
        return { decision: { outcome: "hidden" }, body: { error: "presence is hidden from agents by policy" }, isError: true };
      }
      // ...require the target place to actually exist (no name probing / dangling
      // reminders)...
      const target = await scope.places.get(place);
      if (!target) return none(`no place named "${place}"`);
      // ...and cap total active reminders so a read-scoped token cannot exhaust
      // storage (review finding M2).
      if ((await scope.reminders.countActive()) >= MAX_ACTIVE_REMINDERS) {
        return err(`reminder limit reached (${MAX_ACTIVE_REMINDERS} active)`);
      }
      const reminder = await scope.reminders.create(place, message);
      return ok({ id: reminder.id, place: reminder.placeName, message: reminder.message });
    },
  );

  // Maps calls made for this agent are logged under its credential (GeoService).
  const geoCaller: AgentCaller = { kind: "agent", credential: credentialOf(principal), surface: "mcp", scopes: principal.scopes };

  const etaInput = {
    to: z.string().min(1).max(200).describe("A registered place name (preferred, e.g. 'home', 'office') or an address / place to search"),
    pick: z.number().int().min(1).max(30).optional().describe("When a search matched several places: the number of the one meant"),
    departAt: z.iso.datetime({ offset: true }).optional().describe("Future departure time (ISO 8601 with offset); omit for now"),
    avoid: z.array(z.enum(ROUTE_AVOID)).max(3).optional().describe("Road kinds to avoid"),
    reason: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe("Why the precise route is needed; required (with precise access) for an address destination or for turn-by-turn steps"),
  };
  type EtaArgs = { to: string; pick?: number; departAt?: string; avoid?: Array<(typeof ROUTE_AVOID)[number]>; reason?: string };
  const eta = async (args: EtaArgs, directions: boolean): Promise<Reply> =>
    etaReply(
      await scope.geo.eta(
        {
          to: args.to,
          pick: args.pick,
          departAt: args.departAt ? new Date(args.departAt) : undefined,
          avoid: args.avoid,
          directions,
          reason: args.reason,
        },
        geoCaller,
      ),
    );

  registerTool(
    "get_eta",
    {
      description:
        "Roughly how long it takes the user to drive from where they are now to one of their registered places (e.g. 'home', 'office'), with live traffic (Kakao or Naver). Returns minutes in 5-minute steps, whole kilometres, an arrival time to 5 minutes and the main roads away from both ends; never coordinates. The answer still reveals roughly how far the user is from that place. An address instead of a place name needs precise access and a reason. Allowed only when the user turned on ETA for agents, never while they are at or near home, and only from a live reading or a quiet phone inside a registered place; freshness and originAgeMin say how old the starting point is.",
      inputSchema: etaInput,
    },
    async (args) => eta(args, false),
  );

  registerTool(
    "get_directions",
    {
      description:
        "Like get_eta, plus the provider's turn-by-turn steps when the agent may read the precise location (they name the streets around the user, so they need read_precise_location, the user's permission and a reason; otherwise stepsWithheld says why), and map links (Kakao Map web, Naver Map app) when allowed, which start from the device's own location.",
      inputSchema: etaInput,
    },
    async (args) => eta(args, true),
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

  registerTool(
    "create_place",
    {
      description:
        "Register a place / geofence at explicit coordinates, or at an address or place name looked up with the user's maps provider. type is home, work, or custom; radiusM defaults to 150m. An address that matches several places returns them numbered; call again with pick. Creating or changing a 'home' place may require an admin token when home place protection is enabled.",
      inputSchema: {
        name: z.string().min(1).max(64).describe("Place name, e.g. 'gym'"),
        type: placeType.describe("home | work | custom"),
        lat: z.number().min(-90).max(90).optional(),
        lon: z.number().min(-180).max(180).optional(),
        address: z.string().min(1).max(200).optional().describe("An address or place to look up instead of lat/lon"),
        pick: z.number().int().min(1).max(30).optional().describe("When the address matched several places: the number of the one meant"),
        radiusM: z.number().positive().max(100_000).optional().describe("Geofence radius in meters (default 150)"),
      },
    },
    async ({ name, type, lat, lon, address, pick, radiusM }) => {
      const byPoint = lat !== undefined && lon !== undefined;
      if (byPoint === (address !== undefined) || (lat === undefined) !== (lon === undefined)) {
        return err("give either lat and lon, or address");
      }
      const denied = await homeWriteDenied(name, type);
      if (denied) return err(denied);
      if ((await scope.places.count()) >= MAX_PLACES) {
        return err(`place limit reached (${MAX_PLACES})`);
      }
      let point = byPoint ? { lat: lat!, lon: lon! } : null;
      let found: string | undefined;
      if (!point) {
        const search = await scope.geo.search(address!, geoCaller);
        if (search.kind !== "ok") return searchReply(search);
        const chosen = pickCandidate(search.candidates, pick);
        if (chosen.kind === "none") return none(`nothing found for "${address}"`);
        if (chosen.kind === "ambiguous") {
          return ok({
            ambiguous: true,
            note: "several places match; call again with pick set to the number of the one meant",
            candidates: numbered(candidateViews(search.candidates, canManagePlaces)),
          });
        }
        point = { lat: chosen.candidate.lat, lon: chosen.candidate.lon };
        found = chosen.candidate.roadAddress ?? chosen.candidate.address;
      }
      const place = await scope.places.upsert({
        name,
        type,
        lat: point.lat,
        lon: point.lon,
        radiusM: radiusM ?? DEFAULT_PLACE_RADIUS_M,
      });
      // Same as the REST surface: a new/moved place can change the current
      // geofence verdict, so re-evaluate against the last known location and
      // dispatch any resulting events (commit bd529b2 parity).
      const result = await scope.presence.reevaluateCurrent();
      if (result) await ctx.onEvents?.(result.events);
      return ok({ name: place.name, type: place.type, radiusM: place.radiusM, ...(found ? { address: found } : {}) });
    },
  );

  registerTool(
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
      if (!current?.precise) return none("no current location available to remember");
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
