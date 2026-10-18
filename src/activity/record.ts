/**
 * The one way a surface records an agent request. REST (api/accessAudit.ts)
 * and MCP (mcp/server.ts) both record every request through it, so no route
 * or tool can forget. A session is the owner looking at their own data and is
 * not recorded. Recording never fails the request; a failure is logged.
 */

import type { UserScope } from "../app/context.js";
import type { Principal } from "../auth/principal.js";
import { log } from "../util/log.js";
import type { AccessAction, AccessDecision, AccessSurface, Credential } from "./types.js";

/** Who to name in the log, or null when the request is not an agent's. */
export function credentialOf(principal: Principal): Credential | null {
  switch (principal.via) {
    case "token":
      return { kind: "token", id: principal.tokenId, name: principal.tokenName };
    case "session":
      return null;
  }
}

export interface AccessCall extends AccessDecision {
  action: AccessAction;
  reason?: string;
}
export type AccessRecorder = (call: AccessCall) => Promise<void>;

export function accessRecorder(
  scope: Pick<UserScope, "accessLog">,
  principal: Principal,
  surface: AccessSurface,
): AccessRecorder {
  const credential = credentialOf(principal);
  if (!credential) return async () => {};
  return async ({ precise, ...call }) => {
    try {
      await scope.accessLog.record({ ...call, precise: precise ?? false, credential, surface });
    } catch (e) {
      log.error("could not record an agent request", e, { action: call.action, surface });
    }
  };
}
