/**
 * A signed-in person's own account: profile, passkeys, sessions, recovery
 * codes, and re-authentication. Every method takes the acting session first;
 * routes reach them only through the AccountScope that binds it.
 *
 * Step-up: adding or deleting a passkey and replacing recovery codes need a
 * passkey proof from this session within the last 10 minutes (sign-in counts;
 * otherwise POST /v1/me/reauth). A stolen session cookie alone cannot take
 * over the account by planting a passkey or reading out fresh recovery codes.
 * Deleting a passkey or replacing recovery codes also ends every other
 * session, since both are what someone does after losing a device.
 */

import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { type Clock, systemClock } from "../util/time.js";
import type { Ceremonies } from "./ceremonies.js";
import type { PasskeyCeremony } from "./passkeys.js";
import type { PasskeysStore } from "./passkeysStore.js";
import type { RecoveryStore } from "./recoveryStore.js";
import type { SessionsStore } from "./sessionsStore.js";
import {
  fail,
  hasFreshAuth,
  ok,
  type Actor,
  type PasskeyInfo,
  type Result,
  type SessionId,
  type SessionInfo,
  type User,
  type WorkspaceMembership,
} from "./types.js";
import type { UsersStore } from "./usersStore.js";
import type { WorkspacesStore } from "./workspacesStore.js";
import { DEFAULT_PASSKEY_NAME, type CeremonyStart } from "./authService.js";

export interface Profile {
  user: User;
  workspaces: WorkspaceMembership[];
  passkeys: PasskeyInfo[];
  sessions: Array<SessionInfo & { current: boolean }>;
}

export interface SelfServiceDeps {
  users: UsersStore;
  workspaces: WorkspacesStore;
  passkeys: PasskeysStore;
  sessions: SessionsStore;
  recovery: RecoveryStore;
  ceremonies: Ceremonies;
  webauthn: PasskeyCeremony;
  clock?: Clock;
}

const badCeremony = () => fail("unauthorized", "passkey verification failed");

export class SelfService {
  private readonly clock: Clock;

  constructor(private readonly deps: SelfServiceDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  async profile(actor: Actor): Promise<Result<Profile>> {
    const user = await this.deps.users.get(actor.userId);
    if (!user) return fail("not_found", "user not found");
    const [workspaces, passkeys, sessions] = await Promise.all([
      this.deps.workspaces.listForUser(actor.userId),
      this.deps.passkeys.list(actor.userId),
      this.deps.sessions.list(actor.userId),
    ]);
    return ok({
      user,
      workspaces,
      passkeys,
      sessions: sessions.map((s) => ({ ...s, current: s.id === actor.sessionId })),
    });
  }

  async rename(actor: Actor, displayName: string): Promise<Result<User>> {
    const user = await this.deps.users.rename(actor.userId, displayName);
    return user ? ok(user) : fail("not_found", "user not found");
  }

  // ---- re-authentication ----

  async reauthOptions(
    actor: Actor,
  ): Promise<CeremonyStart<PublicKeyCredentialRequestOptionsJSON>> {
    const options = await this.deps.webauthn.authenticationOptions(
      await this.deps.passkeys.listIds(actor.userId),
    );
    const ceremony = this.deps.ceremonies.seal(
      { purpose: "reauth", userId: actor.userId },
      options.challenge,
    );
    return { ceremony, options };
  }

  /** Prove a passkey of this account again, refreshing the session's step-up window. */
  async reauthVerify(
    actor: Actor,
    state: string,
    response: AuthenticationResponseJSON,
  ): Promise<Result<void>> {
    const opened = await this.deps.ceremonies.open(state, "reauth");
    if (!opened || opened.binding.userId !== actor.userId) return badCeremony();
    const passkey = await this.deps.passkeys.get(response.id);
    if (!passkey || passkey.userId !== actor.userId) return badCeremony();
    const verified = await this.deps.webauthn.verifyAuthentication(
      response,
      opened.challenge,
      passkey,
    );
    if (!verified) return badCeremony();
    if (!(await this.deps.passkeys.recordUse(passkey.credentialId, verified.newCounter))) {
      return badCeremony();
    }
    await this.deps.sessions.markReauthenticated(actor.userId, actor.sessionId);
    return ok(undefined);
  }

  // ---- passkeys (step-up) ----

  async addPasskeyOptions(
    actor: Actor,
  ): Promise<Result<CeremonyStart<PublicKeyCredentialCreationOptionsJSON>>> {
    const fresh = this.requireFreshAuth(actor);
    if (!fresh.ok) return fresh;
    const subject = await this.deps.users.registrationSubject(actor.userId);
    if (!subject) return fail("not_found", "user not found");
    const options = await this.deps.webauthn.registrationOptions(
      subject,
      await this.deps.passkeys.listIds(actor.userId),
    );
    const ceremony = this.deps.ceremonies.seal(
      { purpose: "addPasskey", userId: actor.userId },
      options.challenge,
    );
    return ok({ ceremony, options });
  }

  async addPasskeyVerify(
    actor: Actor,
    state: string,
    response: RegistrationResponseJSON,
    passkeyName: string | undefined,
  ): Promise<Result<PasskeyInfo>> {
    const fresh = this.requireFreshAuth(actor);
    if (!fresh.ok) return fresh;
    const opened = await this.deps.ceremonies.open(state, "addPasskey");
    if (!opened || opened.binding.userId !== actor.userId) return badCeremony();
    const credential = await this.deps.webauthn.verifyRegistration(response, opened.challenge);
    if (!credential) return badCeremony();
    const added = await this.deps.passkeys.add(actor.userId, {
      ...credential,
      name: passkeyName ?? DEFAULT_PASSKEY_NAME,
    });
    return added ? ok(added) : fail("conflict", "this passkey is already registered");
  }

  async deletePasskey(actor: Actor, credentialId: string): Promise<Result<void>> {
    const fresh = this.requireFreshAuth(actor);
    if (!fresh.ok) return fresh;
    const outcome = await this.deps.passkeys.delete(actor.userId, credentialId);
    if (outcome === "not_found") return fail("not_found", "passkey not found");
    if (outcome === "last_passkey") {
      return fail("last_passkey", "cannot delete your only passkey; add another first");
    }
    await this.deps.sessions.revokeOthers(actor.userId, actor.sessionId);
    return ok(undefined);
  }

  /** Replace every recovery code; the new ones are shown once. */
  async regenerateRecoveryCodes(actor: Actor): Promise<Result<string[]>> {
    const fresh = this.requireFreshAuth(actor);
    if (!fresh.ok) return fresh;
    const codes = await this.deps.recovery.regenerate(actor.userId);
    await this.deps.sessions.revokeOthers(actor.userId, actor.sessionId);
    return ok(codes);
  }

  // ---- sessions ----

  async revokeSession(actor: Actor, id: SessionId): Promise<Result<void>> {
    return (await this.deps.sessions.revoke(actor.userId, id))
      ? ok(undefined)
      : fail("not_found", "session not found");
  }

  /** Sign out everywhere else; returns how many sessions ended. */
  revokeOtherSessions(actor: Actor): Promise<number> {
    return this.deps.sessions.revokeOthers(actor.userId, actor.sessionId);
  }

  private requireFreshAuth(actor: Actor): Result<void> {
    return hasFreshAuth(actor.reauthAt, this.clock())
      ? ok(undefined)
      : fail("reauth_required", "confirm with your passkey first (POST /v1/me/reauth)");
  }
}
