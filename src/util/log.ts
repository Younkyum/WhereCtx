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
 * read. It goes to stdout as is and never into the ring.
 */

import { LOG_LEVELS, type LogEntry, type LogLevel } from "./logEntry.js";

export { LOG_LEVELS, type LogEntry, type LogLevel };

export type LogFields = Record<string, unknown>;

export const RING_SIZE = 1000;
const REDACTED = "[redacted]";

const SENSITIVE_KEY =
  /^(lat|lon|lng|latitude|longitude)$|precise|password|passwd|secret|token|authorization|cookie|session|recovery|setup_?code|access_?code|signature/i;

const STRING_RULES: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[^\s"',;]+/gi, `$1 ${REDACTED}`],
  [/\b(authorization|cookie|set-cookie)(["']?\s*[:=]\s*)[^\n]+/gi, `$1$2${REDACTED}`],
  [/([?&](?:token|code|secret|password)=)[^&\s"']+/gi, `$1${REDACTED}`],
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

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactString(value);
  if (value instanceof Error) {
    return redactString(value.stack ?? `${value.name}: ${value.message}`);
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= 4) return "[object]";
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactValue(v, depth + 1);
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

function write(level: LogLevel, msg: string, fields?: LogFields): void {
  const entry: LogEntry = {
    level,
    time: new Date().toISOString(),
    msg: redactString(msg),
    ...(fields && Object.keys(fields).length > 0 ? { fields: redactFields(fields) } : {}),
  };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
  stream.write(formatEntry(entry) + "\n");
}

/** `err` becomes a field, so a stack trace is redacted like any other value. */
function withError(fields: LogFields | undefined, err: unknown): LogFields | undefined {
  return err === undefined ? fields : { ...fields, err };
}

export const log = {
  debug: (msg: string, fields?: LogFields) => write("debug", msg, fields),
  info: (msg: string, fields?: LogFields) => write("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => write("warn", msg, fields),
  error: (msg: string, err?: unknown, fields?: LogFields) => write("error", msg, withError(fields, err)),
  /** Operator-facing text with a secret in it: stdout only, unredacted, never kept. */
  banner: (text: string) => {
    process.stdout.write(text + "\n");
  },
};

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
