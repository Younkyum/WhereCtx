/**
 * The security headers every response carries (review finding D3): the Hono
 * app sets them through `secureHeaders` and `pageSecurity`, and the OAuth
 * server's responses, which bypass Hono, get the same values from
 * `securityHeaders`.
 *
 * One strict policy for every response. Its only opening is img-src for the
 * map tile origin (MAP_TILE_URL, dashboard/mapTiles.ts): the map code is
 * bundled with the dashboard, so scripts stay 'self'. The page sends no
 * Referer; the map's tile images ask for the origin alone themselves, which
 * OpenStreetMap's tile policy requires. The policy depends on the
 * configuration alone, never on the request, so any cache may keep it.
 */

import type { MiddlewareHandler } from "hono";
import type { secureHeaders } from "hono/secure-headers";
import type { MapTiles } from "../dashboard/mapTiles.js";

type SecureHeadersOptions = NonNullable<Parameters<typeof secureHeaders>[0]>;

function csp(tiles: MapTiles | null) {
  return {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"], // dashboard JS is a built file under /dashboard/assets/ (M5)
    // The design system adds a few <style> elements at runtime (overlay
    // motion, code highlighting), so inline styles stay allowed.
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: tiles ? ["'self'", tiles.origin] : ["'self'"],
    connectSrc: ["'self'"],
    frameSrc: ["'none'"],
    frameAncestors: ["'none'"],
    baseUri: ["'none'"],
    formAction: ["'self'"],
  } satisfies Record<string, readonly string[]>;
}

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const serialize = (directives: Record<string, readonly string[]>) =>
  Object.entries(directives)
    .map(([directive, sources]) => `${kebab(directive)} ${sources.join(" ")}`)
    .join("; ");

interface PagePolicy {
  "content-security-policy": string;
  "referrer-policy": string;
  "x-frame-options": string;
}

export function pagePolicy(tiles: MapTiles | null): Readonly<PagePolicy> {
  return {
    "content-security-policy": serialize(csp(tiles)),
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  };
}

/** Everything but the CSP, the referrer policy and framing, which `pageSecurity` sets. */
export const SECURE_HEADERS_OPTIONS = {
  referrerPolicy: false,
  xFrameOptions: false,
  xContentTypeOptions: "nosniff",
} satisfies SecureHeadersOptions;

/** The only writer of the CSP, the referrer policy and framing. */
export function pageSecurity(tiles: MapTiles | null): MiddlewareHandler {
  const policy = pagePolicy(tiles);
  return async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(policy)) c.res.headers.set(name, value);
  };
}

export function securityHeaders(tiles: MapTiles | null): Readonly<Record<string, string>> {
  const policy = pagePolicy(tiles);
  return {
    "Content-Security-Policy": policy["content-security-policy"],
    "X-Frame-Options": policy["x-frame-options"],
    "X-Content-Type-Options": SECURE_HEADERS_OPTIONS.xContentTypeOptions,
    "Referrer-Policy": policy["referrer-policy"],
  };
}
