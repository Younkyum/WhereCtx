/**
 * Dashboard router: the HTML shell at /dashboard (and /dashboard/, the form
 * invite links use) plus the files in DASHBOARD_ASSETS. Nothing here needs a
 * session; the page signs in through the API. Scripts are files, never inline,
 * so the CSP keeps script-src 'self'.
 */

import { Hono } from "hono";
import { etag } from "hono/etag";
import { DASHBOARD_ASSETS } from "./assets.js";
import { DASHBOARD_HTML } from "./page.js";

export function dashboardRouter(): Hono {
  const app = new Hono();
  // Revalidate every load: the modules import each other, so a browser must
  // never mix files from two releases. The ETag keeps revalidation cheap.
  app.use("/dashboard/*", etag(), async (c, next) => {
    await next();
    c.res.headers.set("Cache-Control", "no-cache");
  });
  app.get("/dashboard", (c) => c.html(DASHBOARD_HTML));
  app.get("/dashboard/", (c) => c.html(DASHBOARD_HTML));
  app.get("/dashboard/:file", (c) => {
    const file = c.req.param("file");
    const asset = Object.hasOwn(DASHBOARD_ASSETS, file) ? DASHBOARD_ASSETS[file] : undefined;
    if (!asset) return c.json({ error: "not found" }, 404);
    return c.body(asset.body, 200, { "content-type": asset.contentType });
  });
  return app;
}
