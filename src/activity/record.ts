/**
 * The one way a surface records an agent read. REST (api/accessAudit.ts) and
 * MCP (mcp/server.ts) both wrap every handler in it, so no route or tool can
 * forget. A session is the owner looking at their own data and is not
 * recorded. Recording never fails the request; a failure is logged.
 */

import type { UserScope } from "../app/context.js";
import type { Principal } from "../auth/principal.js";
import { log } from "../util/log.js";
import type { AccessOutcome, AccessRecord, AccessSurface, Credential } from "./types.js";

/** Who to name in the log, or null when the request is not an agent's. */
export function credentialOf(principal: Principal): Credential | null {
  switch (principal.via) {
    case "token":
      return { kind: "token", id: principal.tokenId, name: principal.tokenName };
    case "session":
      return null;
  }
}

export type AccessResult = Pick<AccessRecord, "outcome" | "denial">;
export type AccessCall = Pick<AccessRecord, "action" | "precise" | "reason"> & AccessResult;
export type AccessRecorder = (call: AccessCall) => Promise<void>;

export function accessRecorder(
  scope: Pick<UserScope, "accessLog">,
  principal: Principal,
  surface: AccessSurface,
): AccessRecorder {
  const credential = credentialOf(principal);
  if (!credential) return async () => {};
  return async (call) => {
    try {
      await scope.accessLog.record({ ...call, credential, surface });
    } catch (e) {
      log.error("could not record an agent read", e, { action: call.action, surface });
    }
  };
}

const isHidden = (body: unknown): boolean =>
  typeof body === "object" &&
  body !== null &&
  ((body as { privacy?: unknown }).privacy === "hidden" || (body as { hidden?: unknown }).hidden === true);

function message(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { error, detail } = body as { error?: unknown; detail?: unknown };
  const parts = [error, Array.isArray(detail) ? detail.join("; ") : detail].filter(
    (p): p is string => typeof p === "string" && p !== "",
  );
  return parts.length ? parts.join(": ") : undefined;
}

/** A REST response's outcome: 2xx and 404 were served, a hidden-mode body is hidden, any other error is denied. */
export function restOutcome(status: number, body: unknown): AccessResult {
  if (isHidden(body)) return { outcome: "hidden" };
  if (status < 400 || status === 404) return { outcome: "allowed" };
  return { outcome: "denied", denial: message(body) ?? `status ${status}` };
}

/** An MCP tool result's outcome: isError is denied, a hidden marker is hidden. */
export function toolOutcome(result: { isError?: boolean; content?: Array<{ type: string; text?: string }> }): AccessResult {
  const text = result.content?.find((c) => c.type === "text")?.text;
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (result.isError) return { outcome: "denied", denial: message(body) ?? text ?? "tool error" };
  return { outcome: isHidden(body) ? "hidden" : ("allowed" satisfies AccessOutcome) };
}
