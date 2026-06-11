/**
 * Validation helpers shared across routers. Flattens zod errors to a compact,
 * message-only summary so internal schema details (received types, full paths,
 * offending values) are not echoed verbatim to clients (review finding P11).
 */

import type { ZodError } from "zod";

export function zodMessages(error: ZodError): string[] {
  return error.issues.map((i) => {
    const path = i.path.join(".");
    return path ? `${path}: ${i.message}` : i.message;
  });
}

/**
 * Parse a `?limit=` query into [1, max], with a fallback for absent/invalid
 * input. The stores cap defensively too; capping here as well keeps the bound
 * visible at the API boundary (review L2).
 */
export function parseLimit(
  raw: string | undefined,
  fallback: number,
  max: number,
): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(1, n), max);
}
