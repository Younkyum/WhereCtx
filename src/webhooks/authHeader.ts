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

/** RFC 9110 field-name token characters. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Visible ASCII and the space; no control characters, so no CR/LF. */
const VISIBLE = /^[\x20-\x7e]+$/;

/**
 * Names a delivery cannot carry: framing and hop-by-hop headers, the ones the
 * dispatcher sets itself, and cookies.
 */
const RESERVED = new Set([
  "host",
  "content-length",
  "content-type",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "upgrade",
  "te",
  "trailer",
  "trailers",
  "keep-alive",
  "expect",
  "cookie",
  "user-agent",
]);
const RESERVED_PREFIXES = ["proxy-", "x-wherectx-"];

export type AuthHeaderProblem = "name" | "reserved" | "value";

/** Why `name` and `value` cannot be an auth header, or null when they can. Expects a trimmed value. */
export function authHeaderProblem(name: string, value: string): AuthHeaderProblem | null {
  if (name.length === 0 || name.length > MAX_AUTH_HEADER_NAME || !TOKEN.test(name)) return "name";
  const lower = name.toLowerCase();
  if (RESERVED.has(lower) || RESERVED_PREFIXES.some((p) => lower.startsWith(p))) return "reserved";
  if (value.length === 0 || value.length > MAX_AUTH_HEADER_VALUE || !VISIBLE.test(value)) return "value";
  return null;
}

/** Below this length the last four characters are too much of the value to show. */
const HINT_MIN_LENGTH = 12;

/** "…" and the value's last four characters, or "…" alone for a short value. */
export function authHeaderHint(value: string): string {
  return value.length >= HINT_MIN_LENGTH ? `…${value.slice(-4)}` : "…";
}

export function viewAuthHeader(header: WebhookAuthHeader): WebhookAuthHeaderView {
  return { name: header.name, hint: authHeaderHint(header.value) };
}
