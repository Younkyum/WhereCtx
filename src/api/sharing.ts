/**
 * Location sharing between people (session only: agent and device tokens
 * never see other people, and never grant access to their owner).
 *   GET    /v1/shares                        -> { outgoing, incoming }
 *   GET    /v1/shares/audit?limit=           -> my shares' audit, newest first
 *   PUT    /v1/shares/:viewerUserId          -> share with a co-member {level, hideHomeExact?}
 *                                               (step-up to create or widen)
 *   DELETE /v1/shares/:viewerUserId          -> stop sharing
 *   DELETE /v1/shares/incoming/:ownerUserId  -> stop seeing someone who shares with me
 *   GET    /v1/people                        -> everyone sharing with me, no coordinates
 *   GET    /v1/people/:ownerUserId           -> one of them, coordinates when allowed
 *
 * Someone who shares no workspace with me answers 404, like a missing
 * member, so the routes do not reveal who exists. Grants, changes, revokes
 * and precise views go to the owner's share audit, never to presence events.
 */

import { Hono } from "hono";
import { z } from "zod";
import { asUserId, SHARE_LEVELS } from "../types.js";
import { parseBody, respond } from "./accountHttp.js";
import { noStore } from "./middleware.js";
import { parseLimit } from "./validation.js";
import type { SessionEnv } from "./types.js";

const PutShare = z.object({
  level: z.enum(SHARE_LEVELS),
  hideHomeExact: z.boolean().optional(),
});

export function sharesRouter(): Hono<SessionEnv> {
  const app = new Hono<SessionEnv>();

  app.get("/", async (c) => c.json(await c.get("account").sharing.list()));

  app.get("/audit", async (c) => {
    const limit = parseLimit(c.req.query("limit"), 50, 500);
    return c.json({ audit: await c.get("account").sharing.audit(limit) });
  });

  app.put("/:viewerUserId", async (c) => {
    const body = await parseBody(c, PutShare);
    if (body instanceof Response) return body;
    const result = await c.get("account").sharing.put(asUserId(c.req.param("viewerUserId")), body);
    return respond(c, result, (share) => c.json({ share }));
  });

  app.delete("/incoming/:ownerUserId", async (c) => {
    const result = await c.get("account").sharing.decline(asUserId(c.req.param("ownerUserId")));
    return respond(c, result, () => c.json({ ok: true }));
  });

  app.delete("/:viewerUserId", async (c) => {
    const result = await c.get("account").sharing.revoke(asUserId(c.req.param("viewerUserId")));
    return respond(c, result, () => c.json({ ok: true }));
  });

  return app;
}

export function peopleRouter(): Hono<SessionEnv> {
  const app = new Hono<SessionEnv>();
  // Where people are right now: never kept by a browser or proxy cache.
  app.use("*", noStore);

  app.get("/", async (c) => c.json({ people: await c.get("account").sharing.people() }));

  app.get("/:ownerUserId", async (c) => {
    const result = await c.get("account").sharing.person(asUserId(c.req.param("ownerUserId")));
    return respond(c, result, (person) => c.json({ person }));
  });

  return app;
}
