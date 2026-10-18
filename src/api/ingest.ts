/**
 * Ingest API (plan section 9.1). Device-token endpoints (write_location scope)
 * that accept location updates from various sources, normalize them, and feed
 * the presence service.
 *
 * Every request that authenticated lands in the owner's ingest log with its
 * outcome (accepted, rejected, ignored) and never its coordinates. An
 * unauthenticated request names no owner and is not recorded.
 */

import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { RouteContext, UserScope } from "../app/context.js";
import type { IngestRoute, IngestVerdict } from "../activity/types.js";
import {
  NormalizeError,
  normalizeGenericPayload,
  normalizeOwnTracksPayload,
  normalizeShortcutPayload,
  type NormalizedReading,
} from "../normalizer/index.js";
import { log } from "../util/log.js";
import { nowIso } from "../util/time.js";
import type { ProcessResult } from "../presence/service.js";
import { requireScope } from "./middleware.js";
import type { AppEnv } from "./types.js";

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new NormalizeError("request body must be valid JSON");
  }
}

const ROUTE_PATHS: Record<IngestRoute, RegExp> = {
  generic: /\/v1\/ingest\/?$/,
  shortcut: /\/v1\/ingest\/shortcut\/?$/,
  owntracks: /\/v1\/ingest\/owntracks\/?$/,
};

function routeOf(path: string): IngestRoute | null {
  for (const [route, pattern] of Object.entries(ROUTE_PATHS) as Array<[IngestRoute, RegExp]>) {
    if (pattern.test(path)) return route;
  }
  return null;
}

async function verdictFromResponse(res: Response): Promise<IngestVerdict> {
  if (res.status < 400) return { outcome: "accepted" };
  let reason = `status ${res.status}`;
  try {
    const body = (await res.clone().json()) as { error?: unknown; detail?: unknown };
    const detail = typeof body.detail === "string" ? body.detail : undefined;
    if (typeof body.error === "string") reason = detail ? `${body.error}: ${detail}` : body.error;
  } catch {
    /* keep the status */
  }
  return { outcome: "rejected", reason };
}

/** Records the request's outcome after the handler (and the scope check) ran. */
const recordIngest: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const source = routeOf(c.req.path);
  if (!source) return;
  const principal = c.get("principal");
  const verdict = c.get("ingestVerdict") ?? (await verdictFromResponse(c.res));
  try {
    await c.get("scope").ingestLog.record({
      ...verdict,
      source,
      token: principal.via === "token" ? { id: principal.tokenId, name: principal.tokenName } : null,
    });
  } catch (e) {
    log.error("could not record an upload", e, { source });
  }
};

export function ingestRouter(ctx: RouteContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", recordIngest, requireScope("write_location"));

  const process = async (
    scope: UserScope,
    reading: NormalizedReading,
  ): Promise<ProcessResult> => {
    const result = await scope.presence.processReading(reading);
    await ctx.onEvents?.(result.events);
    return result;
  };

  // Generic JSON ingest.
  app.post("/", async (c) => {
    try {
      const body = await readJson(c);
      const reading = normalizeGenericPayload(body, nowIso(ctx.clock));
      const result = await process(c.get("scope"), reading);
      return c.json({ ok: true, status: result.presence.status });
    } catch (err) {
      if (err instanceof NormalizeError) return c.json({ ok: false, error: err.message }, 400);
      throw err;
    }
  });

  // iOS Shortcut ingest.
  app.post("/shortcut", async (c) => {
    try {
      const body = await readJson(c);
      const reading = normalizeShortcutPayload(body, nowIso(ctx.clock));
      const result = await process(c.get("scope"), reading);
      return c.json({ ok: true, status: result.presence.status });
    } catch (err) {
      if (err instanceof NormalizeError) return c.json({ ok: false, error: err.message }, 400);
      throw err;
    }
  });

  // OwnTracks HTTP ingest. OwnTracks expects a JSON array response and posts
  // several message types; non-location messages are acked with [].
  app.post("/owntracks", async (c) => {
    try {
      const body = await readJson(c);
      const reading = normalizeOwnTracksPayload(body, nowIso(ctx.clock));
      if (reading === null) {
        c.set("ingestVerdict", { outcome: "ignored", reason: "not a location message" });
        return c.json([]);
      }
      await process(c.get("scope"), reading);
      return c.json([]); // OwnTracks ignores the body; [] = no commands
    } catch (err) {
      if (err instanceof NormalizeError) {
        // Preserve the OwnTracks array-response contract even on bad payloads,
        // so the client does not retry-loop; the rejection is logged (P10).
        log.warn("owntracks ingest rejected", { error: err.message });
        c.set("ingestVerdict", { outcome: "rejected", reason: err.message });
        return c.json([], 200);
      }
      throw err;
    }
  });

  return app;
}
