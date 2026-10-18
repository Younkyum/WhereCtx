/**
 * Signing in, for people who are not signed in yet: first-owner setup, login,
 * invite preview and sign-up, recovery codes, operator access codes, and
 * logout. Each WebAuthn flow is two calls (options, then verify) joined by a
 * signed ceremony state (./ceremonies.ts) the client carries between them.
 *
 * Every failure a guesser could cause (wrong setup or access code, bad
 * assertion, unknown invite or recovery code, forged or replayed ceremony) is
 * `unauthorized`, which the routes answer with 401 so the auth-failure limiter
 * counts it.
 *
 * Setup: while no passkey exists, boot mints a one-time code, stores its hash
 * in the database, and prints the code to the server log. Only someone who can
 * read that log can register the first passkey, which goes to the install's
 * USER_ID (already owner of Default).
 */

import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { generateCode, hashToken, newId, normalizeCode, secretsEqual } from "../auth/secrets.js";
import type { SettingsStore } from "../privacy/settingsStore.js";
import { asUserId, type UserId } from "../types.js";
import { accessCodeHash, type AccessCodesStore } from "./accessCodesStore.js";
import type { Ceremonies } from "./ceremonies.js";
import type { InvitesStore, Redemption } from "./invitesStore.js";
import type { PasskeyCeremony } from "./passkeys.js";
import type { PasskeysStore } from "./passkeysStore.js";
import { parseRecoveryCode, type RecoveryStore } from "./recoveryStore.js";
import type { ServerSecretsStore } from "./serverSecretsStore.js";
import type { SessionsStore } from "./sessionsStore.js";
import {
  fail,
  ok,
  type Result,
  type SessionId,
  type Workspace,
  type WorkspaceRole,
} from "./types.js";
import { newWebauthnHandle, type UsersStore } from "./usersStore.js";

export const DEFAULT_PASSKEY_NAME = "Passkey";

/** A setup code like `K7QM-2XRB-9TWD`. */
export function generateSetupCode(): string {
  return generateCode(3, 4);
}

export function setupCodeHash(code: string): string {
  return hashToken(normalizeCode(code));
}

export interface CeremonyStart<O> {
  /** Signed ceremony state; send it back unchanged with the verify call. */
  ceremony: string;
  options: O;
}

export interface SignedIn {
  userId: UserId;
  sessionId: SessionId;
  /** Cookie value for the new session; never stored. */
  sessionSecret: string;
}

export interface Enrolled extends SignedIn {
  recoveryCodes: string[];
}

export interface ClientInfo {
  userAgent?: string;
  /** The session cookie the request already carried; a new sign-in replaces it. */
  priorSession?: string;
}

export interface InvitePreview {
  workspaceName: string;
  role: WorkspaceRole;
  expiresAt: string;
}

export interface AuthDeps {
  users: UsersStore;
  passkeys: PasskeysStore;
  sessions: SessionsStore;
  recovery: RecoveryStore;
  invites: InvitesStore;
  accessCodes: AccessCodesStore;
  serverSecrets: ServerSecretsStore;
  settings: SettingsStore;
  ceremonies: Ceremonies;
  webauthn: PasskeyCeremony;
  /** Receives the setup passkey. */
  ownerId: UserId;
}

const badCeremony = () => fail("unauthorized", "passkey verification failed");
const alreadyRegistered = () => fail("conflict", "this passkey is already registered");

function redemptionFailure(reason: Exclude<Redemption, { ok: true }>["reason"]) {
  switch (reason) {
    case "unknown":
      return fail("unauthorized", "invite not found");
    case "already_member":
      return fail("conflict", "you are already a member of this workspace");
    case "limit":
      return fail("conflict", "workspace limit reached");
    default:
      return fail("gone", `invite ${reason}`);
  }
}

export class PasskeyAuth {
  constructor(private readonly deps: AuthDeps) {}

  // ---- first-owner setup ----

  async setupOptions(
    code: string,
  ): Promise<Result<CeremonyStart<PublicKeyCredentialCreationOptionsJSON>>> {
    const gate = await this.checkSetupCode(code);
    if (!gate.ok) return gate;
    const { ownerId } = this.deps;
    return this.registration({ purpose: "setup", userId: ownerId }, ownerId);
  }

  async setupVerify(
    code: string,
    state: string,
    response: RegistrationResponseJSON,
    passkeyName: string | undefined,
    client: ClientInfo,
  ): Promise<Result<Enrolled>> {
    const gate = await this.checkSetupCode(code);
    if (!gate.ok) return gate;
    const opened = await this.deps.ceremonies.open(state, "setup");
    if (!opened) return badCeremony();
    const credential = await this.deps.webauthn.verifyRegistration(response, opened.challenge);
    if (!credential) return badCeremony();
    const { userId } = opened.binding;
    const stored = await this.deps.passkeys.addFirst(userId, {
      ...credential,
      name: passkeyName ?? DEFAULT_PASSKEY_NAME,
    });
    if (!stored) return fail("gone", "setup already completed");
    await this.deps.serverSecrets.clearSetupCode();
    return ok(await this.enroll(userId, client));
  }

  private async checkSetupCode(code: string): Promise<Result<void>> {
    const stored = await this.deps.serverSecrets.setupCodeHash();
    if (stored === null || (await this.deps.passkeys.countAll()) > 0) {
      return fail("gone", "setup already completed");
    }
    if (!secretsEqual(setupCodeHash(code), stored)) {
      return fail("unauthorized", "invalid setup code");
    }
    return ok(undefined);
  }

  // ---- login ----

  async loginOptions(): Promise<CeremonyStart<PublicKeyCredentialRequestOptionsJSON>> {
    const options = await this.deps.webauthn.authenticationOptions();
    return { ceremony: this.deps.ceremonies.seal({ purpose: "login" }, options.challenge), options };
  }

  async loginVerify(
    state: string,
    response: AuthenticationResponseJSON,
    client: ClientInfo,
  ): Promise<Result<SignedIn>> {
    const opened = await this.deps.ceremonies.open(state, "login");
    if (!opened) return badCeremony();
    const passkey = await this.deps.passkeys.get(response.id);
    if (!passkey) return badCeremony();
    const verified = await this.deps.webauthn.verifyAuthentication(
      response,
      opened.challenge,
      passkey,
    );
    if (!verified) return badCeremony();
    if (!(await this.deps.passkeys.recordUse(passkey.credentialId, verified.newCounter))) {
      return badCeremony();
    }
    return ok(await this.signIn(passkey.userId, client));
  }

  // ---- invites ----

  /** What an invite link offers, for the page shown before signing up or accepting. */
  async previewInvite(token: string): Promise<Result<InvitePreview>> {
    const found = await this.deps.invites.lookup(token);
    if (!found) return fail("unauthorized", "invite not found");
    if (found.state !== "valid") return fail("gone", `invite ${found.state}`);
    return ok({
      workspaceName: found.workspace.name,
      role: found.invite.role,
      expiresAt: found.invite.expiresAt,
    });
  }

  async inviteOptions(
    token: string,
    displayName: string,
  ): Promise<Result<CeremonyStart<PublicKeyCredentialCreationOptionsJSON>>> {
    const usable = await this.previewInvite(token);
    if (!usable.ok) return usable;
    const handle = newWebauthnHandle();
    const options = await this.deps.webauthn.registrationOptions({ handle, name: displayName }, []);
    const ceremony = this.deps.ceremonies.seal(
      {
        purpose: "invite",
        inviteTokenHash: hashToken(token),
        userId: asUserId(newId()),
        handle,
        displayName,
      },
      options.challenge,
    );
    return ok({ ceremony, options });
  }

  async inviteVerify(
    token: string,
    state: string,
    response: RegistrationResponseJSON,
    passkeyName: string | undefined,
    client: ClientInfo,
  ): Promise<Result<Enrolled & { workspace: Workspace; role: WorkspaceRole }>> {
    const opened = await this.deps.ceremonies.open(state, "invite");
    if (!opened || !secretsEqual(opened.binding.inviteTokenHash, hashToken(token))) {
      return badCeremony();
    }
    const credential = await this.deps.webauthn.verifyRegistration(response, opened.challenge);
    if (!credential) return badCeremony();
    if (await this.deps.passkeys.get(credential.credentialId)) return alreadyRegistered();
    const { userId, displayName, handle } = opened.binding;
    const redeemed = await this.deps.invites.redeemAsNewUser(
      token,
      { id: userId, displayName, webauthnHandle: handle },
      { ...credential, name: passkeyName ?? DEFAULT_PASSKEY_NAME },
    );
    if (!redeemed.ok) return redemptionFailure(redeemed.reason);
    await this.deps.settings.getOrSeed(userId);
    const enrolled = await this.enroll(userId, client);
    return ok({ ...enrolled, workspace: redeemed.workspace, role: redeemed.role });
  }

  // ---- recovery and operator access codes ----

  /**
   * Sign in with a recovery code. Whoever lost their passkeys may have lost
   * them to someone else, so every other session of the account ends.
   */
  async recover(code: string, client: ClientInfo): Promise<Result<SignedIn>> {
    const parsed = parseRecoveryCode(code);
    const userId = parsed && (await this.deps.recovery.consume(parsed));
    if (!userId) return fail("unauthorized", "invalid recovery code");
    const signedIn = await this.signIn(userId, client);
    await this.deps.sessions.revokeOthers(userId, signedIn.sessionId);
    return ok(signedIn);
  }

  async accessCodeOptions(
    code: string,
  ): Promise<Result<CeremonyStart<PublicKeyCredentialCreationOptionsJSON>>> {
    const codeHash = accessCodeHash(code);
    const userId = await this.deps.accessCodes.find(codeHash);
    if (!userId) return fail("unauthorized", "invalid access code");
    return this.registration({ purpose: "accessCode", userId, codeHash }, userId);
  }

  /**
   * Register a passkey with an operator-issued access code. Like recovery, it
   * ends the account's other sessions; it also replaces its recovery codes.
   */
  async accessCodeVerify(
    code: string,
    state: string,
    response: RegistrationResponseJSON,
    passkeyName: string | undefined,
    client: ClientInfo,
  ): Promise<Result<Enrolled>> {
    const opened = await this.deps.ceremonies.open(state, "accessCode");
    const codeHash = accessCodeHash(code);
    if (!opened || !secretsEqual(opened.binding.codeHash, codeHash)) return badCeremony();
    const credential = await this.deps.webauthn.verifyRegistration(response, opened.challenge);
    if (!credential) return badCeremony();
    if (await this.deps.passkeys.get(credential.credentialId)) return alreadyRegistered();
    const { userId } = opened.binding;
    const redeemed = await this.deps.accessCodes.redeem(userId, codeHash, {
      ...credential,
      name: passkeyName ?? DEFAULT_PASSKEY_NAME,
    });
    if (!redeemed) return fail("unauthorized", "invalid access code");
    const enrolled = await this.enroll(userId, client);
    await this.deps.sessions.revokeOthers(userId, enrolled.sessionId);
    return ok(enrolled);
  }

  async logout(sessionSecret: string): Promise<void> {
    await this.deps.sessions.revokeSecret(sessionSecret);
  }

  /** Registration options for an existing account, excluding its current passkeys. */
  private async registration(
    binding: Parameters<Ceremonies["seal"]>[0],
    userId: UserId,
  ): Promise<Result<CeremonyStart<PublicKeyCredentialCreationOptionsJSON>>> {
    const subject = await this.deps.users.registrationSubject(userId);
    if (!subject) return fail("unauthorized", "account not found");
    const options = await this.deps.webauthn.registrationOptions(
      subject,
      await this.deps.passkeys.listIds(userId),
    );
    return ok({ ceremony: this.deps.ceremonies.seal(binding, options.challenge), options });
  }

  private async signIn(userId: UserId, client: ClientInfo): Promise<SignedIn> {
    if (client.priorSession) await this.deps.sessions.revokeSecret(client.priorSession);
    const { secret, id } = await this.deps.sessions.create(userId, client.userAgent);
    return { userId, sessionId: id, sessionSecret: secret };
  }

  private async enroll(userId: UserId, client: ClientInfo): Promise<Enrolled> {
    const signedIn = await this.signIn(userId, client);
    return { ...signedIn, recoveryCodes: await this.deps.recovery.regenerate(userId) };
  }
}
