/**
 * The security headers every response carries (review finding D3): the Hono
 * app sets them through `secureHeaders` and `pageSecurity`, and the OAuth
 * server's responses, which bypass Hono, get the same values from
 * `SECURITY_HEADERS`.
 *
 * Every response gets the same strict policy but one static file: the
 * dashboard's map frame (/dashboard/map.html), the only document that loads
 * a provider's map script. Its CSP allows both providers' map hosts
 * (geo/mapSdk.ts), it may be framed by this origin only, and it sends the
 * providers its origin, never its path. The policy depends on the path alone,
 * never on who asks, so any cache may keep it.
 */

import type { MiddlewareHandler } from "hono";
import type { secureHeaders } from "hono/secure-headers";
import { MAP_SDKS } from "../geo/mapSdk.js";
import { GEO_PROVIDERS } from "../geo/types.js";

type SecureHeadersOptions = NonNullable<Parameters<typeof secureHeaders>[0]>;

const CSP = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"], // dashboard JS is a built file under /dashboard/assets/ (M5)
  // The design system adds a few <style> elements at runtime (overlay
  // motion, code highlighting), so inline styles stay allowed.
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'"],
  connectSrc: ["'self'"],
  // The dashboard frames its own map page and nothing else.
  frameSrc: ["'self'"],
  frameAncestors: ["'none'"],
  baseUri: ["'none'"],
  formAction: ["'self'"],
} as const satisfies Record<string, readonly string[]>;

const hostsOf = (directive: "scriptSrc" | "imgSrc" | "connectSrc") => [...new Set(GEO_PROVIDERS.flatMap((p) => MAP_SDKS[p][directive]))];

const MAP_FRAME_CSP = {
  ...CSP,
  scriptSrc: [...CSP.scriptSrc, ...hostsOf("scriptSrc")],
  imgSrc: [...CSP.imgSrc, ...hostsOf("imgSrc")],
  connectSrc: [...CSP.connectSrc, ...hostsOf("connectSrc")],
  frameSrc: ["'none'"],
  frameAncestors: ["'self'"],
} satisfies Record<keyof typeof CSP, readonly string[]>;

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const serialize = (directives: Record<string, readonly string[]>) =>
  Object.entries(directives)
    .map(([directive, sources]) => `${kebab(directive)} ${sources.join(" ")}`)
    .join("; ");

/** The one page that loads a provider's map script (web/map.html). */
export const MAP_FRAME_PATH = "/dashboard/map.html";

interface PagePolicy {
  "content-security-policy": string;
  "referrer-policy": string;
  "x-frame-options": string;
}

export const STRICT_POLICY: Readonly<PagePolicy> = {
  "content-security-policy": serialize(CSP),
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

/** Kakao checks a map key's registered site domain against the Referer, so the frame sends its origin. */
export const MAP_FRAME_POLICY: Readonly<PagePolicy> = {
  "content-security-policy": serialize(MAP_FRAME_CSP),
  "referrer-policy": "strict-origin",
  "x-frame-options": "SAMEORIGIN",
};

/** Everything but the CSP, the referrer policy and framing, which `pageSecurity` sets. */
export const SECURE_HEADERS_OPTIONS = {
  referrerPolicy: false,
  xFrameOptions: false,
  xContentTypeOptions: "nosniff",
} satisfies SecureHeadersOptions;

/** The only writer of the CSP, the referrer policy and framing: by path, the map frame's or the strict one. */
export const pageSecurity: MiddlewareHandler = async (c, next) => {
  await next();
  const policy = c.req.path === MAP_FRAME_PATH ? MAP_FRAME_POLICY : STRICT_POLICY;
  for (const [name, value] of Object.entries(policy)) c.res.headers.set(name, value);
};

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": STRICT_POLICY["content-security-policy"],
  "X-Frame-Options": STRICT_POLICY["x-frame-options"],
  "X-Content-Type-Options": SECURE_HEADERS_OPTIONS.xContentTypeOptions,
  "Referrer-Policy": STRICT_POLICY["referrer-policy"],
};
