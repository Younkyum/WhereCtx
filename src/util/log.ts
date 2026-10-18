/**
 * The server's log: one line per entry on stdout (info) or stderr (warn,
 * error) for `docker logs`, plus the last RING_SIZE entries in memory for the
 * operator's dashboard (GET /v1/admin/logs).
 *
 * Every entry is redacted before it is written anywhere. Field values under a
 * sensitive key are replaced, and secrets and coordinates are masked inside
 * any string, the message included, so a careless call site cannot leak a
 * token, a cookie, or where someone is.
 *
 * `banner` is the one exception: the boot banner and the CLI print a setup
 * code, a generated admin token, or an access code that the operator must
 * read. Those values are Secrets (util/secret.ts), which the other calls
 * refuse at the type level and print as "[secret]" anyway; `banner` reveals
 * them, to stdout only, and never into the ring.
 */

import { DrizzleQueryError } from "drizzle-orm";
import { LOG_LEVELS, type LogEntry, type LogLevel } from "./logEntry.js";
import { Secret } from "./secret.js";

export { LOG_LEVELS, type LogEntry, type LogLevel };

export type LogFields = Record<string, unknown>;

/** Fields with no Secret among their values: the type-level half of keeping secrets out of the ring. */
type NoSecrets<F> = { [K in keyof F]: F[K] extends Secret ? never : F[K] };

export const RING_SIZE = 1000;
const REDACTED = "[redacted]";

/** A key is sensitive when its last word is one of these (`accessToken`, `secret`), not when it merely contains one (`tokensIssued`). */
const SENSITIVE_WORDS = new Set([
  "token",
  "secret",
  "password",
  "passwd",
  "authorization",
  "cookie",
  "session",
  "signature",
  "lat",
  "lon",
  "lng",
  "latitude",
  "longitude",
  "precise",
]);
/** Or when its last two words are one of these (`sessionId`, `setup_code`). */
const SENSITIVE_PAIRS = new Set(["session id", "setup code", "access code", "recovery code", "recovery codes", "api key"]);

export function isSensitiveKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const last = words.at(-1) ?? "";
  return SENSITIVE_WORDS.has(last) || SENSITIVE_PAIRS.has(words.slice(-2).join(" "));
}

/**
 * A credential after "Bearer" or "Basic": six or more token characters with a
 * digit, punctuation, or a lower-then-upper letter, so "Basic auth failed"
 * and "Bearer token missing" stay readable.
 */
const CREDENTIAL = String.raw`(?=[^\s"',;]*(?:[0-9._~+/=-]|[a-z][A-Z]))[^\s"',;]{6,}`;

const STRING_RULES: Array<[RegExp, string]> = [
  [new RegExp(String.raw`\b([Bb]earer|[Bb]asic|BEARER|BASIC)\s+${CREDENTIAL}`, "g"), `$1 ${REDACTED}`],
  [/\b(authorization|cookie|set-cookie)(["']?\s*[:=]\s*)[^\n]+/gi, `$1$2${REDACTED}`],
  // userinfo in a URL: scheme://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@"']+@/gi, `$1${REDACTED}@`],
  // Any query parameter whose name mentions a credential (token, authToken, api_key, code).
  [/([?&][^=&\s"'#]*(?:token|secret|password|key|code|auth)[^=&\s"'#]*=)[^&\s"'#]+/gi, `$1${REDACTED}`],
  [/\b(wctx_session|__Host-wctx_session)=[^;\s"']+/g, `$1=${REDACTED}`],
  [/\bwctx_[A-Za-z0-9_-]+/g, `wctx_${REDACTED}`],
  [/\b(lat|lon|lng|latitude|longitude)(["']?\s*[=:]\s*)-?[\d.]+/gi, `$1$2${REDACTED}`],
  // A lat/lon pair: two decimals with at least 3 fractional digits.
  [/-?\d{1,3}\.\d{3,}\s*[,/ ]\s*-?\d{1,3}\.\d{3,}/g, "[coords]"],
  // Long opaque runs (random secrets, session ids); 32-hex row ids stay readable.
  [/\b[A-Za-z0-9_-]{40,}\b/g, REDACTED],
];

export function redactString(text: string): string {
  let out = text;
  for (const [pattern, replacement] of STRING_RULES) out = out.replace(pattern, replacement);
  return out;
}

const MAX_CAUSE_DEPTH = 3;

const firstLine = (text: string): string => text.split("\n", 1)[0]!;

/**
 * An error as a fixed set of fields: its name, the first line of its message,
 * its code, its stack frames, and its cause. Nothing else an error carries is
 * read, so a query's bound parameters (DrizzleQueryError's `params`, also
 * repeated in its message) never reach a log line.
 */
export function serializeError(err: Error, depth = 0): Record<string, unknown> {
  const name = err.name !== "Error" ? err.name : err.constructor?.name || "Error";
  const message = err instanceof DrizzleQueryError ? `Failed query: ${err.query}` : String(err.message ?? "");
  const code = (err as { code?: unknown }).code;
  const frames = (typeof err.stack === "string" ? err.stack.split("\n") : [])
    .filter((line) => /^\s+at /.test(line))
    .map((line) => redactString(line.trim()));
  const cause = depth < MAX_CAUSE_DEPTH ? err.cause : undefined;
  return {
    name,
    message: redactString(firstLine(message)),
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    ...(frames.length ? { stack: frames } : {}),
    ...(cause === undefined
      ? {}
      : { cause: cause instanceof Error ? serializeError(cause, depth + 1) : redactValue(cause, 3) }),
  };
}

/** One property, or a marker when reading it throws (a getter). */
function readProperty(obj: object, key: string): unknown {
  try {
    return (obj as Record<string, unknown>)[key];
  } catch {
    return "[unreadable]";
  }
}

function redactValue(value: unknown, depth: number): unknown {
  switch (typeof value) {
    case "string":
      return redactString(value);
    case "bigint":
      return value.toString();
    case "symbol":
    case "function":
      return `[${typeof value}]`;
    case "object":
      break;
    default:
      return value;
  }
  if (value === null) return null;
  if (value instanceof Secret) return REDACTED;
  if (value instanceof Error) return serializeError(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  if (value instanceof URL) return redactString(value.href);
  if (depth >= 4) return "[object]";
  if (value instanceof Map) return redactValue(Object.fromEntries(value), depth);
  if (value instanceof Set) return redactValue([...value], depth);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactValue(readProperty(value, key), depth + 1);
  }
  return out;
}

export function redactFields(fields: LogFields): LogFields {
  return redactValue(fields, 0) as LogFields;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return /[\s="]/.test(value) ? JSON.stringify(value) : value;
  return JSON.stringify(value) ?? String(value);
}

/** The stdout form: `2026-10-18T00:00:00.000Z WARN message key=value`. */
export function formatEntry(entry: LogEntry): string {
  const parts = [entry.time, entry.level.toUpperCase(), entry.msg];
  for (const [k, v] of Object.entries(entry.fields ?? {})) {
    if (v !== undefined) parts.push(`${k}=${formatValue(v)}`);
  }
  return parts.join(" ");
}

const ring: LogEntry[] = [];

/** Never throws: a log call must not fail the request that made it. */
function write(level: LogLevel, msg: string, fields?: LogFields): void {
  const time = new Date().toISOString();
  const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
  try {
    const entry: LogEntry = {
      level,
      time,
      msg: redactString(String(msg)),
      ...(fields && Object.keys(fields).length > 0 ? { fields: redactFields(fields) } : {}),
    };
    const line = formatEntry(entry);
    ring.push(entry);
    if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
    stream.write(line + "\n");
  } catch {
    try {
      stream.write(`${time} ${level.toUpperCase()} [a log entry could not be written]\n`);
    } catch {
      /* nowhere left to report it */
    }
  }
}

/** `err` becomes a field, so a stack trace is redacted like any other value. */
function withError(fields: LogFields | undefined, err: unknown): LogFields | undefined {
  return err === undefined ? fields : { ...fields, err };
}

export const log = {
  debug: <F extends LogFields>(msg: string, fields?: F & NoSecrets<F>) => write("debug", msg, fields),
  info: <F extends LogFields>(msg: string, fields?: F & NoSecrets<F>) => write("info", msg, fields),
  warn: <F extends LogFields>(msg: string, fields?: F & NoSecrets<F>) => write("warn", msg, fields),
  error: <F extends LogFields>(msg: string, err?: unknown, fields?: F & NoSecrets<F>) =>
    write("error", msg, withError(fields, err)),
  /**
   * Operator-facing text that may carry a Secret, as a tagged template:
   * log.banner`code: ${setupCode}`. Stdout only, never kept in the ring.
   */
  banner: (strings: TemplateStringsArray, ...values: Array<string | number | Secret>) => {
    const text = strings.reduce(
      (out, part, i) => out + part + (i < values.length ? reveal(values[i]!) : ""),
      "",
    );
    process.stdout.write(text + "\n");
  },
};

const reveal = (value: string | number | Secret): string => (value instanceof Secret ? value.reveal() : String(value));

/** Newest first, at or above `minLevel`. */
export function recentLogs(options: { minLevel?: LogLevel; limit?: number } = {}): LogEntry[] {
  const min = LOG_LEVELS.indexOf(options.minLevel ?? "debug");
  const limit = Math.max(1, Math.min(options.limit ?? 200, RING_SIZE));
  const out: LogEntry[] = [];
  for (let i = ring.length - 1; i >= 0 && out.length < limit; i--) {
    const entry = ring[i]!;
    if (LOG_LEVELS.indexOf(entry.level) >= min) out.push(entry);
  }
  return out;
}

/** Tests only. */
export function clearLogs(): void {
  ring.length = 0;
}
