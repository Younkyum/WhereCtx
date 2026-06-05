/**
 * Ingest API (plan section 9.1). Device-token endpoints (write_location scope)
 * that accept location updates from various sources, normalize them, and feed
 * the presence service.
 */

import { Hono, type Context } from "hono";
import type { AppContext } from "../app/context.js";
import {
  NormalizeError,
  normalizeGenericPayload,
  normalizeOwnTracksPayload,
  normalizeShortcutPayload,
  type NormalizedReading,
} from "../normalizer/index.js";
import { nowIso } from "../util/time.js";
import type { ProcessResult } from "../presence/service.js";
import { bearerAuth, requireScope } from "./middleware.js";
import type { AppEnv } from "./types.js";

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new NormalizeError("request body must be valid JSON");
  }
}

export function ingestRouter(ctx: AppContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // Device clients (Shortcut/OwnTracks) may pass the token via ?token= here only.
  app.use("*", bearerAuth(ctx, { allowQueryToken: true }));
  app.use("*", requireScope("write_location"));

  const process = async (reading: NormalizedReading): Promise<ProcessResult> => {
    const result = await ctx.service.processReading(reading);
    await ctx.onEvents?.(result.events);
    return result;
  };

  // Generic JSON ingest.
  app.post("/", async (c) => {
    try {
      const body = await readJson(c);
      const reading = normalizeGenericPayload(body, nowIso(ctx.clock));
      const result = await process(reading);
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
      const result = await process(reading);
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
      if (reading === null) return c.json([]); // non-location message: ack only
      await process(reading);
      return c.json([]); // OwnTracks ignores the body; [] = no commands
    } catch (err) {
      if (err instanceof NormalizeError) {
        // Preserve the OwnTracks array-response contract even on bad payloads,
        // so the client does not retry-loop; the rejection is logged (P10).
        console.warn(`owntracks ingest rejected: ${err.message}`);
        return c.json([], 200);
      }
      throw err;
    }
  });

  return app;
}
