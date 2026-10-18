/**
 * The session cookie and the CSRF rule that comes with cookie auth.
 *
 * On https the cookie is `__Host-wctx_session`: the prefix makes browsers
 * require Secure and Path=/ and refuse a Domain attribute, so a sibling
 * subdomain cannot plant or overwrite it. Plain http (local development)
 * cannot use the prefix and falls back to `wctx_session`. Domain is never set.
 *
 * Browsers attach cookies to cross-site requests, so a cookie-authenticated
 * write is accepted only when its Origin header is this server's own origin.
 * SameSite=Lax already blocks most cross-site POSTs; the Origin check covers
 * the rest (same-site subdomains, older browsers). Bearer requests carry no
 * ambient credential and are not checked.
 */

import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { SESSION_TTL_MS } from "../accounts/sessionsStore.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isSecure(baseUrl: string): boolean {
  return baseUrl.startsWith("https:");
}

export function sessionCookieName(baseUrl: string): string {
  return isSecure(baseUrl) ? "__Host-wctx_session" : "wctx_session";
}

export function readSessionCookie(c: Context, baseUrl: string): string | undefined {
  return getCookie(c, sessionCookieName(baseUrl));
}

export function setSessionCookie(c: Context, secret: string, baseUrl: string): void {
  setCookie(c, sessionCookieName(baseUrl), secret, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: isSecure(baseUrl),
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(c: Context, baseUrl: string): void {
  deleteCookie(c, sessionCookieName(baseUrl), {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: isSecure(baseUrl),
  });
}

/** Whether a cookie-authenticated request may proceed under the CSRF rule. */
export function sessionRequestAllowed(c: Context, baseUrl: string): boolean {
  if (SAFE_METHODS.has(c.req.method)) return true;
  return c.req.header("origin") === new URL(baseUrl).origin;
}
