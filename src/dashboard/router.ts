/**
 * Dashboard router. Serves the static admin HTML page (plan section 9.9).
 * The page itself is unauthenticated (no data); all data calls it makes use the
 * REST API with an admin token the operator supplies in the browser.
 */

import { Hono } from "hono";
import { DASHBOARD_HTML } from "./page.js";

export function dashboardRouter(): Hono {
  const app = new Hono();
  app.get("/", (c) => c.html(DASHBOARD_HTML));
  return app;
}
