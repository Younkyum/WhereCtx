/**
 * Dashboard router. Serves the static admin HTML page (plan section 9.9) and
 * its client script. The page itself is unauthenticated (no data); all data
 * calls it makes use the REST API with an admin token the operator supplies in
 * the browser. The script is a separate response (not inline) so the CSP can
 * stay 'self'-only for scripts.
 */

import { Hono } from "hono";
import { DASHBOARD_HTML, DASHBOARD_JS } from "./page.js";

export function dashboardRouter(): Hono {
  const app = new Hono();
  app.get("/", (c) => c.html(DASHBOARD_HTML));
  app.get("/app.js", (c) =>
    c.body(DASHBOARD_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
      // Short-lived cache: the script changes only on releases, but a stale
      // copy after an upgrade would talk to a newer API.
      "cache-control": "max-age=300",
    }),
  );
  return app;
}
