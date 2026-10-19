/** The shape of a server log entry, shared with the dashboard's Server logs view. */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogEntry {
  level: LogLevel;
  time: string;
  msg: string;
  fields?: Record<string, unknown>;
}
