/**
 * Records every agent or token request to the presence, places and events
 * routes in the owner's access log. Mounted by buildApp after `authenticate`
 * on those prefixes, so a new route there is recorded without asking. The
 * outcome comes from the response, so handlers stay unaware of it.
 */

import type { MiddlewareHandler } from "hono";
import { accessRecorder, restOutcome } from "../activity/record.js";
import { ACCESS_TEXT_MAX, type AccessAction } from "../activity/types.js";
import type { AppEnv } from "./types.js";

interface RestAction {
  method: string;
  path: RegExp;
  action: AccessAction;
  /** The response carries coordinates. */
  precise: boolean;
}

/** Each audited route and the action name the owner sees. */
export const REST_ACTIONS: readonly RestAction[] = [
  { method: "GET", path: /^\/v1\/presence\/?$/, action: "presence.read", precise: false },
  { method: "GET", path: /^\/v1\/presence\/precise\/?$/, action: "presence.precise", precise: true },
  { method: "GET", path: /^\/v1\/presence\/history\/?$/, action: "presence.history", precise: true },
  { method: "GET", path: /^\/v1\/places\/?$/, action: "places.list", precise: false },
  { method: "POST", path: /^\/v1\/places\/?$/, action: "places.write", precise: false },
  { method: "DELETE", path: /^\/v1\/places\/[^/]+\/?$/, action: "places.delete", precise: false },
  { method: "GET", path: /^\/v1\/events\/?$/, action: "events.list", precise: false },
];

export function restActionFor(method: string, path: string): { action: string; precise: boolean } {
  const hit = REST_ACTIONS.find((a) => a.method === method && a.path.test(path));
  if (hit) return { action: hit.action, precise: hit.precise };
  return { action: `${method} ${path}`.slice(0, ACCESS_TEXT_MAX), precise: false };
}

async function jsonBody(res: Response): Promise<unknown> {
  if (!res.headers.get("content-type")?.includes("application/json")) return undefined;
  try {
    return await res.clone().json();
  } catch {
    return undefined;
  }
}

export function auditAccess(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    const record = accessRecorder(c.get("scope"), c.get("principal"), "rest");
    const { action, precise } = restActionFor(c.req.method, c.req.path);
    const reason = precise ? c.req.query("reason") : undefined;
    await record({ action, precise, reason, ...restOutcome(c.res.status, await jsonBody(c.res)) });
  };
}
