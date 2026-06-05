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
