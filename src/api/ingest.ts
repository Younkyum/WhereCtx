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
import { matchedRoute, statusDenial } from "./accessAudit.js";
import { requireScope } from "./middleware.js";
import type { AppEnv } from "./types.js";

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new NormalizeError("request body must be valid JSON");
  }
}

/** Each ingest route, as `METHOD /pattern`, and the name the ingest log gives it. */
const INGEST_ROUTE_OF: Record<string, IngestRoute> = {
  "POST /v1/ingest": "generic",
  "POST /v1/ingest/shortcut": "shortcut",
  "POST /v1/ingest/owntracks": "owntracks",
};

/** The upload's verdict: a handler's own, else a scope refusal, else the status. */
function settleIngest(c: Context<AppEnv>): IngestVerdict {
  const status = c.res.status;
  if (status >= 500) return { outcome: "error" };
  const set = c.get("ingestVerdict");
  if (set) return set;
  const access = c.get("access");
  if (access?.outcome === "denied") return { outcome: "rejected", ...(access.denial ? { reason: access.denial } : {}) };
  if (status < 400) return { outcome: "accepted" };
  return { outcome: "rejected", reason: statusDenial(status) };
}

/** Records the request's outcome after the handler (and the scope check) ran. */
const recordIngest: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const route = matchedRoute(c);
  const source = route ? INGEST_ROUTE_OF[route] : undefined;
  if (!source) return;
  const principal = c.get("principal");
  try {
    await c.get("scope").ingestLog.record({
      ...settleIngest(c),
      source,
      token: principal.via === "token" ? { id: principal.tokenId, name: principal.tokenName } : null,
    });
  } catch (e) {
    log.error("could not record an upload", e, { source });
  }
};

/** A payload that could not be read: 400, and the ingest log says why. */
function rejected(c: Context<AppEnv>, err: NormalizeError): Response {
  c.set("ingestVerdict", { outcome: "rejected", reason: err.message });
  return c.json({ ok: false, error: err.message }, 400);
}

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
      if (err instanceof NormalizeError) return rejected(c, err);
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
      if (err instanceof NormalizeError) return rejected(c, err);
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
        // so the client does not retry-loop; the ingest log records it (P10).
        c.set("ingestVerdict", { outcome: "rejected", reason: err.message });
        return c.json([], 200);
      }
      throw err;
    }
  });

  return app;
}
