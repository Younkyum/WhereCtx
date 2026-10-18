/**
 * WebAuthn ceremony state, carried by the client between the options and
 * verify calls instead of held in server memory. The server signs what the
 * ceremony is for (its binding), the challenge, an expiry, and a nonce with a
 * per-install key (HMAC-SHA256); verify checks the signature, the expiry, and
 * the purpose, then spends the nonce in the database so the state works once.
 *
 * Holding nothing between the two calls means /options endpoints cannot be
 * flooded into evicting real ceremonies, and any instance sharing the database
 * can finish a ceremony another started.
 *
 * Callers still check the binding against the request: that the signed-in
 * user is the bound user, the invite token is the bound one, and so on.
 */

import { createHmac } from "node:crypto";
import type { UserId } from "../types.js";
import { newId, secretsEqual } from "../auth/secrets.js";
import { type Clock, systemClock } from "../util/time.js";
import type { NoncesStore } from "./noncesStore.js";

export const CEREMONY_TTL_MS = 5 * 60_000;

export type CeremonyBinding =
  | { purpose: "setup"; userId: UserId }
  | { purpose: "login" }
  | {
      purpose: "invite";
      inviteTokenHash: string;
      /** The new account, minted at options time so the authenticator stores its handle. */
      userId: UserId;
      handle: string;
      displayName: string;
    }
  | { purpose: "addPasskey"; userId: UserId }
  | { purpose: "reauth"; userId: UserId }
  | { purpose: "accessCode"; userId: UserId; codeHash: string };

export type CeremonyPurpose = CeremonyBinding["purpose"];
export type BindingFor<P extends CeremonyPurpose> = Extract<CeremonyBinding, { purpose: P }>;

type Sealed = CeremonyBinding & { challenge: string; exp: number; nonce: string };

export interface OpenedCeremony<P extends CeremonyPurpose> {
  binding: BindingFor<P>;
  challenge: string;
}

/** `<base64url JSON payload>.<base64url HMAC>`; bounded so a body cannot be huge. */
export const CEREMONY_STATE_PATTERN = /^[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{43}$/;

export class Ceremonies {
  constructor(
    private readonly key: Buffer,
    private readonly nonces: NoncesStore,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Sign a new ceremony; the returned state goes to the client. */
  seal(binding: CeremonyBinding, challenge: string): string {
    const sealed: Sealed = {
      ...binding,
      challenge,
      exp: this.clock().getTime() + CEREMONY_TTL_MS,
      nonce: newId(),
    };
    const payload = Buffer.from(JSON.stringify(sealed), "utf8").toString("base64url");
    return `${payload}.${this.sign(payload)}`;
  }

  /**
   * The ceremony `state` describes, if it is authentic, unexpired, for
   * `purpose`, and not used before. Spends it either way it verifies, so a
   * failed WebAuthn check cannot be retried against the same challenge.
   */
  async open<P extends CeremonyPurpose>(
    state: string,
    purpose: P,
  ): Promise<OpenedCeremony<P> | null> {
    const dot = state.indexOf(".");
    if (dot < 0) return null;
    const payload = state.slice(0, dot);
    if (!secretsEqual(state.slice(dot + 1), this.sign(payload))) return null;
    const sealed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Sealed;
    if (sealed.exp <= this.clock().getTime() || sealed.purpose !== purpose) return null;
    const expiresAt = new Date(sealed.exp).toISOString();
    if (!(await this.nonces.spend(sealed.nonce, expiresAt))) return null;
    const { challenge, exp: _exp, nonce: _nonce, ...binding } = sealed;
    return { binding: binding as BindingFor<P>, challenge };
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.key).update(payload, "utf8").digest("base64url");
  }
}
