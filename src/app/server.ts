/**
 * HTTP application assembly. Mounts every REST router plus health/info routes
 * onto a single Hono app. The MCP endpoint is mounted separately in Phase 4.
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { AppContext } from "./context.js";
import { AuthFailureLimiter, authFailureGuard } from "../api/rateLimit.js";
import { bearerAuth } from "../api/middleware.js";
import type { AppEnv } from "../api/types.js";
import { dashboardRouter } from "../dashboard/router.js";
import { eventsRouter } from "../api/events.js";
import { ingestRouter } from "../api/ingest.js";
import { placesRouter } from "../api/places.js";
import { presenceRouter } from "../api/presence.js";
import { privacyRouter } from "../api/privacy.js";
import { tokensRouter } from "../api/tokens.js";
import { webhooksRouter } from "../api/webhooks.js";

export interface BuildAppOptions {
  /** Shared with the MCP handler so both surfaces count auth failures together. */
  authLimiter?: AuthFailureLimiter;
}

export function buildApp(ctx: AppContext, options: BuildAppOptions = {}): Hono {
  const app = new Hono();
  const authLimiter = options.authLimiter ?? new AuthFailureLimiter();

  // Security headers (defense-in-depth on the admin dashboard especially): CSP,
  // nosniff, frame-deny, no referrer leakage (review finding D3).
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"], // dashboard JS is served at /dashboard/app.js (M5)
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
      },
      xFrameOptions: "DENY",
      xContentTypeOptions: "nosniff",
      referrerPolicy: "no-referrer",
    }),
  );

  // Cap request bodies well above any legitimate payload (ingest/admin bodies
  // are tiny) to close the OOM/DoS vector on an internet-exposed bind (P8).
  app.use(
    "*",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => c.json({ error: "payload too large" }, 413),
    }),
  );

  // Restrictive CORS (review M2): browsers may only read API responses from the
  // configured origin. Non-browser clients are unaffected. The dashboard is
  // same-origin, so this changes nothing for normal operation.
  app.use(
    "/v1/*",
    cors({
      origin: ctx.config.baseUrl,
      allowMethods: ["GET", "POST", "PUT", "DELETE"],
      allowHeaders: ["Authorization", "Content-Type"],
    }),
  );

  // Throttle repeated auth failures per client (review M1).
  app.use("/v1/*", authFailureGuard(authLimiter));

  app.get("/", (c) =>
    c.json({ name: "wherectx", version: "0.1.0", status: "ok" }),
  );
  app.get("/healthz", (c) => c.json({ status: "ok" }));

  app.route("/dashboard", dashboardRouter());

  // Auth is mounted here, the one REST place holding the full context; routers
  // get only the user scope bearerAuth attaches. Device clients
  // (Shortcut/OwnTracks) may pass the token via ?token= on ingest only.
  const mount = (path: string, router: Hono<AppEnv>, auth = bearerAuth(ctx)): void => {
    app.use(`${path}/*`, auth);
    app.route(path, router);
  };
  mount("/v1/ingest", ingestRouter(ctx), bearerAuth(ctx, { allowQueryToken: true }));
  mount("/v1/presence", presenceRouter(ctx));
  mount("/v1/places", placesRouter(ctx));
  mount("/v1/events", eventsRouter());
  mount("/v1/privacy", privacyRouter(ctx));
  mount("/v1/webhooks", webhooksRouter(ctx));
  mount("/v1/tokens", tokensRouter());

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    // eslint-disable-next-line no-console
    console.error("request error:", err);
    return c.json({ error: "internal server error" }, 500);
  });

  return app;
}
