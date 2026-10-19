/**
 * Records every token request to the /v1 routes in the owner's access log
 * (all but /v1/ingest, which keeps its own log, and /v1/auth, which takes no
 * token). buildApp mounts `auditAccess` ahead of the credential check on each
 * prefix, so a new route there is recorded without asking.
 *
 * The outcome is the request's typed decision: the scope guards, the privacy
 * policy and the handlers set it with `decide`, and `settle` fills in what
 * they left open from the status alone. No response body is read.
 */

import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import type { AppContext } from "../app/context.js";
import type { Principal } from "../auth/principal.js";
import { accessRecorder } from "../activity/record.js";
import type { AccessAction, AccessDecision } from "../activity/types.js";

/** What the code handling a request knows about its outcome so far. */
export type AccessNote = Partial<AccessDecision> & {
  /** The reason an agent gave for a precise request. */
  reason?: string;
};

type AuditEnv = { Variables: { principal?: Principal; access?: AccessNote } };

/** Each route under an `authenticate` mount, as `METHOD /pattern`, and the action the owner sees. */
export const REST_ACTIONS = {
  "GET /v1/presence": "presence.read",
  "GET /v1/presence/precise": "presence.precise",
  "GET /v1/presence/history": "presence.history",
  "GET /v1/places": "places.list",
  "POST /v1/places": "places.write",
  "DELETE /v1/places/:name": "places.delete",
  "GET /v1/events": "events.list",
  "GET /v1/privacy": "privacy.read",
  "PUT /v1/privacy": "privacy.update",
  "GET /v1/webhooks": "webhooks.list",
  "POST /v1/webhooks": "webhooks.create",
  "GET /v1/webhooks/dead-letters": "webhooks.dead_letters",
  "PATCH /v1/webhooks/:id": "webhooks.update",
  "DELETE /v1/webhooks/:id": "webhooks.delete",
  "GET /v1/tokens": "tokens.list",
  "POST /v1/tokens": "tokens.create",
  "DELETE /v1/tokens/:id": "tokens.revoke",
  "GET /v1/devices": "devices.list",
  "POST /v1/devices/pair": "devices.pair",
  "GET /v1/activity/access": "activity.read",
  "GET /v1/activity/ingest": "activity.read",
  "GET /v1/admin/logs": "admin.logs",
  "GET /v1/geo": "geo.settings",
  "GET /v1/geo/map-config": "geo.map_config",
  "PUT /v1/geo/credentials/:provider": "geo.credentials.write",
  "DELETE /v1/geo/credentials/:provider": "geo.credentials.delete",
  "PUT /v1/geo/credentials/:provider/map": "geo.credentials.write",
  "DELETE /v1/geo/credentials/:provider/map": "geo.credentials.delete",
  "POST /v1/geo/credentials/:provider/test": "geo.credentials.test",
  "GET /v1/geo/search": "geo.search",
  "GET /v1/geo/eta": "geo.eta",
} as const satisfies Record<string, AccessAction>;

/**
 * The route the request matched, as `METHOD /pattern`, or null when none did.
 * A HEAD request is routed, and so named, as GET.
 */
export function matchedRoute(c: Context): string | null {
  const routes = matchedRoutes(c);
  for (let i = routes.length - 1; i >= 0; i--) {
    const route = routes[i]!;
    if (route.method !== "ALL") return `${route.method} ${route.path}`;
  }
  return null;
}

/** Add to the request's decision. Later calls refine earlier ones. */
export function decide(c: Context, note: AccessNote): void {
  c.set("access", { ...(c.get("access") as AccessNote | undefined), ...note });
}

/** Refuse with `status` and record the refusal with the same words. */
export function refuse(c: Context, status: 400 | 403, error: string, detail?: string): Response {
  decide(c, { outcome: "denied", denial: detail ? `${error}: ${detail}` : error });
  return c.json(detail ? { error, detail } : { error }, status);
}

const STATUS_DENIAL: Record<number, string> = {
  400: "invalid request",
  401: "unauthorized",
  403: "forbidden",
  409: "conflict",
  413: "payload too large",
  429: "too many requests",
};

export const statusDenial = (status: number): string => STATUS_DENIAL[status] ?? `status ${status}`;

/** The decision once the response exists: a server failure is an error whatever was decided; a 404 on a known route was served. */
export function settle(note: AccessNote | undefined, status: number): AccessDecision {
  const precise = note?.precise ?? false;
  if (status >= 500) return { outcome: "error", precise };
  if (note?.outcome) return { outcome: note.outcome, ...(note.denial ? { denial: note.denial } : {}), precise };
  if (status < 400 || status === 404) return { outcome: "allowed", precise };
  return { outcome: "denied", denial: statusDenial(status), precise };
}

/**
 * Record each token request after it is answered. `actionOf` names the
 * matched route; a request no route matched is "unknown" and denied, and its
 * path is never stored.
 */
export function auditAccess(
  ctx: Pick<AppContext, "forUser">,
  actionOf: (route: string) => AccessAction,
): MiddlewareHandler<AuditEnv> {
  return async (c, next) => {
    await next();
    const principal = c.get("principal");
    if (principal?.via !== "token") return;
    const route = matchedRoute(c);
    const note = c.get("access");
    const decision: AccessDecision = route
      ? settle(note, c.res.status)
      : { outcome: "denied", denial: "no such route" };
    const record = accessRecorder(ctx.forUser(principal.userId), principal, "rest");
    await record({
      action: route ? actionOf(route) : "unknown",
      ...decision,
      ...(decision.precise && note?.reason !== undefined ? { reason: note.reason } : {}),
    });
  };
}

/** Actions under an `authenticate` mount: the table, else "unknown". */
export const restActionOf = (route: string): AccessAction =>
  (REST_ACTIONS as Record<string, AccessAction>)[route] ?? "unknown";
