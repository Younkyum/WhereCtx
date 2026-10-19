/**
 * A webhook's auth header: one request header, such as
 * `Authorization: Bearer <token>`, sent with every delivery to that hook so a
 * receiver that checks a credential (n8n header auth, an internal API) accepts
 * it. Unlike the signing secret, the receiver does not verify the body with it.
 *
 * The value is a credential: it is stored encrypted, sent only to its own
 * hook's URL, and shown back only as `hint`. Pure, no Node APIs, so the
 * dashboard checks a form with the same rules the server enforces.
 */

export interface WebhookAuthHeader {
  name: string;
  value: string;
}

/** What a client is ever shown of an auth header. */
export interface WebhookAuthHeaderView {
  name: string;
  hint: string;
}

export const DEFAULT_AUTH_HEADER_NAME = "Authorization";
export const MAX_AUTH_HEADER_NAME = 64;
export const MAX_AUTH_HEADER_VALUE = 1024;

/** Letters, digits and hyphens: every allowed name is spelled this way. */
const NAME = /^[A-Za-z0-9-]+$/;
/** Visible ASCII and the space; no control characters, so no CR/LF. */
const VISIBLE = /^[\x20-\x7e]+$/;

/**
 * The names a credential travels in. An allow-list, not a blocklist: a name
 * that steers a proxy or the receiver (Forwarded, X-Forwarded-*, X-Real-IP,
 * X-HTTP-Method-Override, Origin, Metadata-Flavor) is refused because it is
 * not on it, not because someone remembered it.
 */
const ALLOWED_NAMES = new Set(["authorization", "api-key", "x-api-key"]);
const ALLOWED_X_SUFFIXES = ["-token", "-key", "-api-key", "-auth", "-authorization", "-secret", "-signature"];
/** The dispatcher's own headers, which the X- rule would otherwise admit. */
const RESERVED_PREFIX = "x-wherectx-";

export const AUTH_HEADER_NAME_RULE =
  "Authorization, Api-Key, X-Api-Key, or an X- name ending in -Token, -Key, -Auth, -Authorization, -Secret or -Signature (not X-WhereCtx-)";

export type AuthHeaderProblem = "name" | "notAllowed" | "value";

function nameAllowed(lower: string): boolean {
  if (ALLOWED_NAMES.has(lower)) return true;
  if (!lower.startsWith("x-") || lower.startsWith(RESERVED_PREFIX)) return false;
  const rest = lower.slice(2);
  return ALLOWED_X_SUFFIXES.some((suffix) => rest.endsWith(suffix));
}

/** Why `name` and `value` cannot be an auth header, or null when they can. Expects a trimmed value. */
export function authHeaderProblem(name: string, value: string): AuthHeaderProblem | null {
  if (name.length === 0 || name.length > MAX_AUTH_HEADER_NAME || !NAME.test(name)) return "name";
  if (!nameAllowed(name.toLowerCase())) return "notAllowed";
  if (value.length === 0 || value.length > MAX_AUTH_HEADER_VALUE || !VISIBLE.test(value)) return "value";
  return null;
}

/**
 * The shortest token whose last four characters are at most a fifth of it.
 * Shorter tokens show nothing: four characters would be too much of them.
 */
const HINT_MIN_TOKEN = 20;

/**
 * "…" and the last four characters of the token, or "…" alone. The token is
 * the value after an optional scheme ("Bearer "), so the hint never counts the
 * scheme toward the length. A Basic value is base64 of user:password, whose
 * tail is the password, so it shows nothing.
 */
export function authHeaderHint(value: string): string {
  const scheme = /^(\S+)\s+/.exec(value);
  if (scheme && scheme[1]!.toLowerCase() === "basic") return "…";
  const token = scheme ? value.slice(scheme[0].length) : value;
  return token.length >= HINT_MIN_TOKEN ? `…${token.slice(-4)}` : "…";
}

/**
 * Whether a hook at `url` may not carry an auth header: one travels only over
 * https, unless private targets are allowed, since a LAN receiver often has no
 * certificate.
 */
export function authHeaderNeedsHttps(url: string, allowPrivateTargets: boolean): boolean {
  return !allowPrivateTargets && !/^https:/i.test(url);
}

export function viewAuthHeader(header: WebhookAuthHeader): WebhookAuthHeaderView {
  return { name: header.name, hint: authHeaderHint(header.value) };
}
