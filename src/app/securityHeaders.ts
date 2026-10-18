/**
 * The security headers every response carries (review finding D3): the Hono
 * app sets them through `secureHeaders`, and the OAuth server's responses,
 * which bypass Hono, get the same values from `SECURITY_HEADERS`.
 */

import type { secureHeaders } from "hono/secure-headers";

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
};

export const SECURE_HEADERS_OPTIONS = {
  contentSecurityPolicy: CSP,
  xFrameOptions: "DENY",
  xContentTypeOptions: "nosniff",
  referrerPolicy: "no-referrer",
} satisfies SecureHeadersOptions;

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": Object.entries(CSP)
    .map(([directive, sources]) => `${kebab(directive)} ${sources.join(" ")}`)
    .join("; "),
  "X-Frame-Options": SECURE_HEADERS_OPTIONS.xFrameOptions,
  "X-Content-Type-Options": SECURE_HEADERS_OPTIONS.xContentTypeOptions,
  "Referrer-Policy": SECURE_HEADERS_OPTIONS.referrerPolicy,
};
