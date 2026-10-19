/**
 * Maps: my provider keys, address search, and ETA from where I am.
 *   GET    /v1/geo                              -> which provider and key calls use, my keys' hints (session)
 *   PUT    /v1/geo/credentials/:provider        -> save my REST keys for kakao|naver (session, step-up)
 *   DELETE /v1/geo/credentials/:provider        -> forget them (session, step-up)
 *   POST   /v1/geo/credentials/:provider/test   -> look up Seoul City Hall with them, never my location (session)
 *   GET    /v1/geo/search?q=                    -> candidates with coordinates (manage_places)
 *   GET    /v1/geo/eta?to=&pick=&departAt=&avoid= -> drive time from my current location (read_presence)
 *
 * A saved key never comes back: answers carry the kinds held and a
 * four-character hint. The provider calls themselves are logged by
 * GeoService; this router's requests by the access audit, like any route.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { RouteContext } from "../app/context.js";
import { credentialOf } from "../activity/record.js";
import type { GeoCaller, EtaOutcome } from "../geo/service.js";
import { GEO_PROVIDERS, ROUTE_AVOID, type GeoProviderName } from "../geo/types.js";
import { decide, refuse } from "./accessAudit.js";
import { noStore, requireFreshSession, requireScope, requireSession } from "./middleware.js";
import { zodMessages } from "./validation.js";
import type { AppEnv } from "./types.js";
import type { Context } from "hono";

/** The REST key kinds each provider's form takes; a key is printable ASCII without spaces. */
const key = z.string().trim().min(8).max(256).regex(/^[\x21-\x7e]+$/, "a key has no spaces or non-ASCII characters");
const KEY_FORMS = {
  kakao: z.object({ restKey: key }).strict(),
  naver: z.object({ clientId: key, clientSecret: key }).strict(),
} satisfies Record<GeoProviderName, z.ZodType>;

const Provider = z.enum(GEO_PROVIDERS);

const EtaQuery = z.object({
  to: z.string().trim().min(1).max(200),
  pick: z.coerce.number().int().min(1).max(30).optional(),
  departAt: z.iso.datetime({ offset: true }).optional(),
  avoid: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").map((s) => s.trim()) : undefined))
    .pipe(z.array(z.enum(ROUTE_AVOID)).optional()),
});

function callerOf(c: Context<AppEnv>): GeoCaller {
  const principal = c.get("principal");
  const credential = credentialOf(principal);
  if (!credential) return { kind: "owner" };
  return { kind: "agent", credential, surface: "rest", seesPlaceCoordinates: principal.scopes.includes("manage_places") };
}

/** One ETA outcome as an HTTP answer, with the access decision it means. */
function etaResponse(c: Context<AppEnv>, outcome: EtaOutcome): Response {
  switch (outcome.kind) {
    case "ok":
      return c.json({ eta: outcome.answer });
    case "hidden":
      decide(c, { outcome: "hidden" });
      return c.json({ error: "presence is hidden from agents by policy", privacy: "hidden" }, 403);
    case "denied":
      return refuse(c, 403, "ETA denied", outcome.reason);
    case "no_location":
      return c.json({ error: "no location recorded yet" }, 404);
    case "stale":
      return c.json({ error: "location is stale", updatedAgoSec: outcome.updatedAgoSec }, 409);
    case "not_found":
      return c.json({ error: outcome.reason }, 404);
    case "ambiguous":
      return c.json({ error: "several places match; pass pick", candidates: outcome.candidates }, 409);
    case "rate_limited":
      return c.json({ error: "too many maps requests; try again in a minute" }, 429);
    case "unconfigured":
      return c.json({ error: "no maps key is set up (Maps & routes)" }, 409);
    case "failed":
      return c.json({ error: outcome.message, kind: outcome.error }, 502);
  }
}

export function geoRouter(ctx: RouteContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/", requireSession, noStore, async (c) => c.json(await c.get("scope").geo.status()));

  app.put("/credentials/:provider", requireSession, requireFreshSession(ctx), async (c) => {
    const provider = Provider.safeParse(c.req.param("provider"));
    if (!provider.success) return c.json({ error: "unknown provider" }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "request body must be valid JSON" }, 400);
    }
    const parsed = KEY_FORMS[provider.data].safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid key", detail: zodMessages(parsed.error) }, 400);
    const saved = await c.get("scope").geo.saveCredential(provider.data, parsed.data);
    return c.json({ credential: saved });
  });

  app.delete("/credentials/:provider", requireSession, requireFreshSession(ctx), async (c) => {
    const provider = Provider.safeParse(c.req.param("provider"));
    if (!provider.success || !(await c.get("scope").geo.deleteCredential(provider.data))) {
      return c.json({ error: "no key saved for this provider" }, 404);
    }
    return c.json({ ok: true });
  });

  app.post("/credentials/:provider/test", requireSession, async (c) => {
    const provider = Provider.safeParse(c.req.param("provider"));
    if (!provider.success) return c.json({ error: "unknown provider" }, 404);
    return c.json({ test: await c.get("scope").geo.testCredential(provider.data) });
  });

  app.get("/search", requireScope("manage_places"), noStore, async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (q.length === 0 || q.length > 200) return refuse(c, 400, "q must be 1 to 200 characters");
    const outcome = await c.get("scope").geo.search(q, callerOf(c));
    switch (outcome.kind) {
      case "ok":
        return c.json({ provider: outcome.provider, candidates: outcome.candidates });
      case "rate_limited":
        return c.json({ error: "too many maps requests; try again in a minute" }, 429);
      case "unconfigured":
        return c.json({ error: "no maps key is set up (Maps & routes)" }, 409);
      case "failed":
        return c.json({ error: outcome.message, kind: outcome.error }, 502);
    }
  });

  app.get("/eta", requireScope("read_presence"), noStore, async (c) => {
    const query = EtaQuery.safeParse({
      to: c.req.query("to"),
      pick: c.req.query("pick"),
      departAt: c.req.query("departAt"),
      avoid: c.req.query("avoid"),
    });
    if (!query.success) return c.json({ error: "invalid query", detail: zodMessages(query.error) }, 400);
    const { to, pick, departAt, avoid } = query.data;
    const outcome = await c.get("scope").geo.eta(
      { to, pick, departAt: departAt ? new Date(departAt) : undefined, avoid },
      callerOf(c),
    );
    return etaResponse(c, outcome);
  });

  return app;
}
