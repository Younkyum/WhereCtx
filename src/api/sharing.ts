/**
 * Location sharing between people (session only: agent and device tokens
 * never see other people, and never grant access to their owner).
 *   GET    /v1/shares                -> { outgoing, incoming }
 *   PUT    /v1/shares/:viewerUserId  -> share with a co-member {level, hideHomeExact?}
 *   DELETE /v1/shares/:viewerUserId  -> stop sharing
 *   GET    /v1/people                -> everyone sharing with me, with what each allows
 *
 * Someone who shares no workspace with me answers 404, like a missing
 * member, so the routes do not reveal who exists. Grants, changes, revokes
 * and precise views are written to the owner's presence events.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { RouteContext } from "../app/context.js";
import { asUserId, SHARE_LEVELS } from "../types.js";
import { parseBody, respond } from "./accountHttp.js";
import type { SessionEnv } from "./types.js";

const PutShare = z.object({
  level: z.enum(SHARE_LEVELS),
  hideHomeExact: z.boolean().optional(),
});

export function sharesRouter(ctx: RouteContext): Hono<SessionEnv> {
  const app = new Hono<SessionEnv>();

  app.get("/", async (c) => c.json(await c.get("account").sharing.list()));

  app.put("/:viewerUserId", async (c) => {
    const body = await parseBody(c, PutShare);
    if (body instanceof Response) return body;
    const result = await c.get("account").sharing.put(asUserId(c.req.param("viewerUserId")), body);
    return respond(c, result, async ({ value, events }) => {
      if (events.length > 0) await ctx.onEvents?.(events);
      return c.json({ share: value });
    });
  });

  app.delete("/:viewerUserId", async (c) => {
    const result = await c.get("account").sharing.revoke(asUserId(c.req.param("viewerUserId")));
    return respond(c, result, async ({ events }) => {
      await ctx.onEvents?.(events);
      return c.json({ ok: true });
    });
  });

  return app;
}

export function peopleRouter(ctx: RouteContext): Hono<SessionEnv> {
  const app = new Hono<SessionEnv>();

  app.get("/", async (c) => {
    const { value, events } = await c.get("account").sharing.people();
    if (events.length > 0) await ctx.onEvents?.(events);
    return c.json({ people: value });
  });

  return app;
}
