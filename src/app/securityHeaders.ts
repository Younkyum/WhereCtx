/**
 * The security headers every response carries (review finding D3): the Hono
 * app sets them through `secureHeaders` and `pageSecurity`, and the OAuth
 * server's responses, which bypass Hono, get the same values from
 * `SECURITY_HEADERS`.
 *
 * The CSP and the referrer policy are the same strict pair everywhere but on
 * the dashboard page of someone whose map is set up, which also allows that
 * one provider's map hosts (geo/mapSdk.ts) and sends them its origin
 * (`contentSecurityPolicy`, dashboard/router.ts).
 */

import type { MiddlewareHandler } from "hono";
import type { secureHeaders } from "hono/secure-headers";
import { MAP_SDKS } from "../geo/mapSdk.js";
import type { GeoProviderName } from "../geo/types.js";

type SecureHeadersOptions = NonNullable<Parameters<typeof secureHeaders>[0]>;

const CSP = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"], // dashboard JS is a built file under /dashboard/assets/ (M5)
  // The design system adds a few <style> elements at runtime (overlay
  // motion, code highlighting), so inline styles stay allowed.
  styleSrc: ["'self'", "'unsafe-inline'"],
  imgSrc: ["'self'"],
  connectSrc: ["'self'"],
  frameAncestors: ["'none'"],
  baseUri: ["'none'"],
  formAction: ["'self'"],
} as const satisfies Record<string, readonly string[]>;

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The CSP for a response: strict, or for a page that loads `map`'s SDK, strict plus exactly that provider's hosts. */
export function contentSecurityPolicy(map: GeoProviderName | null): string {
  const sdk = map ? MAP_SDKS[map] : null;
  const directives: Record<string, readonly string[]> = sdk
    ? {
        ...CSP,
        scriptSrc: [...CSP.scriptSrc, ...sdk.scriptSrc],
        imgSrc: [...CSP.imgSrc, ...sdk.imgSrc],
        connectSrc: [...CSP.connectSrc, ...sdk.connectSrc],
      }
    : CSP;
  return Object.entries(directives)
    .map(([directive, sources]) => `${kebab(directive)} ${sources.join(" ")}`)
    .join("; ");
}

/**
 * no-referrer everywhere, but a page loading a map sends its origin (never
 * the path): Kakao checks the key's registered site domain against it.
 */
export function referrerPolicy(map: GeoProviderName | null): string {
  return map ? "strict-origin" : "no-referrer";
}

/** Everything but the CSP and referrer policy, which `pageSecurity` sets. */
export const SECURE_HEADERS_OPTIONS = {
  referrerPolicy: false,
  xFrameOptions: "DENY",
  xContentTypeOptions: "nosniff",
} satisfies SecureHeadersOptions;

/** The strict CSP and referrer policy on every response that did not set its own (only the dashboard page does). */
export const pageSecurity: MiddlewareHandler = async (c, next) => {
  await next();
  if (!c.res.headers.has("content-security-policy")) c.res.headers.set("content-security-policy", contentSecurityPolicy(null));
  if (!c.res.headers.has("referrer-policy")) c.res.headers.set("referrer-policy", referrerPolicy(null));
};

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": contentSecurityPolicy(null),
  "X-Frame-Options": SECURE_HEADERS_OPTIONS.xFrameOptions,
  "X-Content-Type-Options": SECURE_HEADERS_OPTIONS.xContentTypeOptions,
  "Referrer-Policy": referrerPolicy(null),
};
