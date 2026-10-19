/**
 * The signed-in person's own activity logs (session only, never a token).
 *   GET /v1/activity/access?limit=&before=&credential=  -> agent and token reads, newest first
 *   GET /v1/activity/ingest?limit=&before=              -> device uploads, newest first
 *
 * `before` is the `next` cursor of the previous page.
 */

import { Hono } from "hono";
import { ACCESS_PAGE_MAX } from "../activity/accessLogStore.js";
import { INGEST_PAGE_MAX } from "../activity/ingestLogStore.js";
import { noStore, requireSession } from "./middleware.js";
import { parseLimit } from "./validation.js";
import type { AppEnv } from "./types.js";

export function activityRouter(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireSession, noStore);

  app.get("/access", async (c) => {
    const page = await c.get("scope").accessLog.list({
      limit: parseLimit(c.req.query("limit"), 50, ACCESS_PAGE_MAX),
      before: c.req.query("before") || undefined,
      credentialId: c.req.query("credential") || undefined,
    });
    return c.json(page);
  });

  app.get("/ingest", async (c) => {
    const page = await c.get("scope").ingestLog.list({
      limit: parseLimit(c.req.query("limit"), 50, INGEST_PAGE_MAX),
      before: c.req.query("before") || undefined,
    });
    return c.json(page);
  });

  return app;
}
