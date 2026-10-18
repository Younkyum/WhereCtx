/**
 * The operator's view of the server (session only; the operator is the
 * instance owner, USER_ID).
 *   GET /v1/admin/logs?level=&limit=  -> recent server log entries, newest first, redacted
 *
 * Anyone else gets 403, a token included, so no agent can read server logs.
 */

import { Hono } from "hono";
import type { RouteContext } from "../app/context.js";
import type { WhereCtxConfig } from "../config.js";
import type { UserId } from "../types.js";
import { LOG_LEVELS, RING_SIZE, recentLogs, type LogLevel } from "../util/log.js";
import { noStore, requireSession } from "./middleware.js";
import { parseLimit } from "./validation.js";
import type { AppEnv } from "./types.js";

export function isOperator(config: Pick<WhereCtxConfig, "defaultUserId">, userId: UserId): boolean {
  return userId === config.defaultUserId;
}

export function adminRouter(ctx: RouteContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireSession, noStore, async (c, next) => {
    if (!isOperator(ctx.config, c.get("principal").userId)) {
      return c.json({ error: "forbidden", detail: "only the server's operator can read its logs" }, 403);
    }
    await next();
  });

  app.get("/logs", (c) => {
    const raw = c.req.query("level");
    if (raw !== undefined && !(LOG_LEVELS as readonly string[]).includes(raw)) {
      return c.json({ error: `level must be one of: ${LOG_LEVELS.join(", ")}` }, 400);
    }
    const entries = recentLogs({
      minLevel: raw as LogLevel | undefined,
      limit: parseLimit(c.req.query("limit"), 200, RING_SIZE),
    });
    return c.json({ entries });
  });

  return app;
}
