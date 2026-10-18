/**
 * WhereCtx's own HTTP around the OAuth server (the protocol endpoints under
 * /oauth/* are oidc-provider's, routed in app/listener.ts):
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]  -> RFC 9728 metadata for /mcp
 *   GET  /oauth/interaction/:uid           -> 303 to the dashboard's consent screen
 *   GET  /oauth/interaction/:uid/details   -> what the client asks for (session)
 *   POST /oauth/interaction/:uid/confirm   -> {precise} -> {redirectTo} (session)
 *   POST /oauth/interaction/:uid/abort     -> {redirectTo} (session)
 *   GET    /v1/oauth/grants                -> the person's connected apps (session)
 *   DELETE /v1/oauth/grants/:id            -> disconnect one (session)
 *
 * The interaction routes read the provider's `_interaction` cookie, whose path
 * is /oauth/interaction/<uid>, so they need the raw Node request.
 */

import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import type { AppContext } from "../app/context.js";
import { parseBody } from "../api/accountHttp.js";
import { noStore, sessionAuth } from "../api/middleware.js";
import type { SessionEnv } from "../api/types.js";
import type { OAuthScope } from "./scopes.js";

type InteractionEnv = SessionEnv & { Bindings: HttpBindings };

const Confirm = z.object({ precise: z.boolean() });

const EXPIRED = {
  error: "this authorization request has expired or was started in another browser",
  code: "interaction_expired",
};

export function oauthRouter(ctx: AppContext): Hono<InteractionEnv> {
  const app = new Hono<InteractionEnv>();
  const signedIn = sessionAuth(ctx);

  const metadata = cors({ origin: "*", allowMethods: ["GET"] });
  for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
    app.use(path, metadata);
    app.get(path, (c) => c.json(ctx.oauth.protectedResourceMetadata()));
  }

  app.get("/oauth/interaction/:uid", (c) =>
    c.redirect(`/dashboard/#authorize/${encodeURIComponent(c.req.param("uid"))}`, 303),
  );

  app.get("/oauth/interaction/:uid/details", signedIn, noStore, async (c) => {
    const request = await ctx.oauth.consentRequest(c.env.incoming, c.env.outgoing, c.req.param("uid"));
    return request ? c.json(request) : c.json(EXPIRED, 404);
  });

  app.post("/oauth/interaction/:uid/confirm", signedIn, async (c) => {
    const body = await parseBody(c, Confirm);
    if (body instanceof Response) return body;
    const optedIn = new Set<OAuthScope>(body.precise ? ["location:precise"] : []);
    const redirectTo = await c
      .get("account")
      .oauth.consent(c.env.incoming, c.env.outgoing, c.req.param("uid"), optedIn);
    return redirectTo ? c.json({ redirectTo }) : c.json(EXPIRED, 404);
  });

  app.post("/oauth/interaction/:uid/abort", signedIn, async (c) => {
    const redirectTo = await ctx.oauth.deny(c.env.incoming, c.env.outgoing, c.req.param("uid"));
    return redirectTo ? c.json({ redirectTo }) : c.json(EXPIRED, 404);
  });

  return app;
}

/** The signed-in person's connected MCP apps, mounted at /v1/oauth behind sessionAuth. */
export function oauthGrantsRouter(): Hono<SessionEnv> {
  const app = new Hono<SessionEnv>();

  app.get("/grants", async (c) => c.json({ grants: await c.get("account").oauth.connectedApps() }));

  app.delete("/grants/:id", async (c) =>
    (await c.get("account").oauth.disconnect(c.req.param("id")))
      ? c.json({ ok: true })
      : c.json({ error: "no such connected app", code: "not_found" }, 404),
  );

  return app;
}
