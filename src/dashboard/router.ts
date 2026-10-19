/**
 * Serves the dashboard's built files (web/, built by Vite into dist/web) at
 * /dashboard/. The files are read once at startup into a table keyed by their
 * path, so a request can only ever name a file that is in the build: there is
 * no filesystem lookup to traverse. Nothing here needs a session; the page
 * signs in through the API.
 *
 * The page's CSP and referrer policy depend on whose browser asks: for a
 * signed-in person whose map is set up, they allow that provider's map hosts
 * (app/securityHeaders.ts); for anyone else they stay strict. They are set
 * after the ETag check, so a revalidated page gets the current ones too.
 */

import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { etag } from "hono/etag";
import { contentSecurityPolicy, referrerPolicy } from "../app/securityHeaders.js";
import type { GeoProviderName } from "../geo/types.js";

/** dist/web from both src/dashboard (tsx, tests) and dist/dashboard (the build). */
export const DASHBOARD_DIR = fileURLToPath(new URL("../../dist/web", import.meta.url));

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Vite puts content-hashed files under assets/; the page itself is revalidated on every load. */
const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";

export interface DashboardFile {
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
  cacheControl: string;
}

/** Every servable file in a build, by its path under /dashboard/. Dotfiles and unknown types are left out. */
export function loadDashboardFiles(dir: string): Map<string, DashboardFile> {
  const files = new Map<string, DashboardFile>();
  let entries: string[];
  try {
    entries = readdirSync(dir, { recursive: true, encoding: "utf8" });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const path = relative(dir, join(dir, entry)).split(sep).join("/");
    const contentType = CONTENT_TYPES[extname(path)];
    if (!contentType || path.split("/").some((part) => part.startsWith("."))) continue;
    files.set(path, {
      body: readFileSync(join(dir, entry)),
      contentType,
      cacheControl: path.startsWith("assets/") ? IMMUTABLE : REVALIDATE,
    });
  }
  return files;
}

/** Whose map, if any, the page loads for this request's browser; null for anyone signed out. */
export type MapProviderOf = (c: Context) => Promise<GeoProviderName | null>;

const pagePath = (c: Context) => c.req.path.slice("/dashboard/".length) || "index.html";

export function dashboardRouter(dir: string = DASHBOARD_DIR, mapProviderOf: MapProviderOf = async () => null): Hono {
  const files = loadDashboardFiles(dir);
  const app = new Hono();
  const pageHeaders: MiddlewareHandler = async (c, next) => {
    await next();
    if (pagePath(c) !== "index.html") return;
    const map = await mapProviderOf(c);
    c.header("content-security-policy", contentSecurityPolicy(map));
    c.header("referrer-policy", referrerPolicy(map));
    c.header("vary", "Cookie");
  };
  app.use("/dashboard", pageHeaders, etag());
  app.use("/dashboard/*", pageHeaders, etag());
  const handler = (c: Context) => {
    const path = pagePath(c);
    const file = files.get(path);
    if (file) return c.body(file.body, 200, { "content-type": file.contentType, "cache-control": file.cacheControl });
    if (path === "index.html") return c.text("The dashboard is not built. Run npm run build.", 503);
    return c.json({ error: "not found" }, 404);
  };
  app.get("/dashboard", handler);
  app.get("/dashboard/*", handler);
  return app;
}
