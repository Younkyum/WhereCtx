/**
 * The WebAuthn boundary. `PasskeyCeremony` is everything the account layer
 * needs from WebAuthn; `SimpleWebAuthnCeremony` implements it with
 * @simplewebauthn/server, and tests substitute a fake. Options and responses
 * use SimpleWebAuthn's standard JSON shapes, which the browser produces and
 * consumes directly via navigator.credentials.
 *
 * User verification (biometric or PIN) is required on every ceremony: a
 * passkey is the only credential a person has, so mere presence is not enough.
 */

import { isIP } from "node:net";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { WhereCtxConfig } from "../config.js";
import type { NewPasskey, StoredPasskey } from "./passkeysStore.js";
import type { RegistrationSubject } from "./usersStore.js";

/** A verified new credential, before it is named and stored. */
export type VerifiedCredential = Omit<NewPasskey, "name">;

export interface PasskeyCeremony {
  registrationOptions(
    subject: RegistrationSubject,
    excludeCredentialIds: readonly string[],
  ): Promise<PublicKeyCredentialCreationOptionsJSON>;
  /** The credential, or null when the response does not verify. */
  verifyRegistration(
    response: RegistrationResponseJSON,
    expectedChallenge: string,
  ): Promise<VerifiedCredential | null>;
  /**
   * Sign-in options. With no `allowCredentialIds` any discoverable credential
   * may answer (login); with them, only those (re-authenticating a known user).
   */
  authenticationOptions(
    allowCredentialIds?: readonly string[],
  ): Promise<PublicKeyCredentialRequestOptionsJSON>;
  /** The authenticator's new signature counter, or null when it does not verify. */
  verifyAuthentication(
    response: AuthenticationResponseJSON,
    expectedChallenge: string,
    credential: StoredPasskey,
  ): Promise<{ newCounter: number } | null>;
}

export class SimpleWebAuthnCeremony implements PasskeyCeremony {
  private readonly rpID: string;
  private readonly origin: string;

  constructor(config: Pick<WhereCtxConfig, "baseUrl">) {
    const url = new URL(config.baseUrl);
    this.rpID = url.hostname;
    this.origin = url.origin;
  }

  registrationOptions(subject: RegistrationSubject, excludeCredentialIds: readonly string[]) {
    return generateRegistrationOptions({
      rpName: "WhereCtx",
      rpID: this.rpID,
      userID: new Uint8Array(Buffer.from(subject.handle, "hex")),
      userName: subject.name,
      userDisplayName: subject.name,
      attestationType: "none",
      excludeCredentials: excludeCredentialIds.map((id) => ({ id })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
  }

  async verifyRegistration(response: RegistrationResponseJSON, expectedChallenge: string) {
    try {
      const result = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        requireUserVerification: true,
      });
      if (!result.verified) return null;
      const { credential } = result.registrationInfo;
      return {
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
        transports: credential.transports ?? [],
      };
    } catch {
      return null;
    }
  }

  authenticationOptions(allowCredentialIds?: readonly string[]) {
    return generateAuthenticationOptions({
      rpID: this.rpID,
      userVerification: "required",
      allowCredentials: allowCredentialIds?.map((id) => ({ id })),
    });
  }

  async verifyAuthentication(
    response: AuthenticationResponseJSON,
    expectedChallenge: string,
    credential: StoredPasskey,
  ) {
    try {
      // Throws on a counter regression (a cloned authenticator), among others.
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        requireUserVerification: true,
        credential: {
          id: credential.credentialId,
          publicKey: new Uint8Array(Buffer.from(credential.publicKey, "base64url")),
          counter: credential.counter,
          transports: credential.transports,
        },
      });
      return result.verified ? { newCounter: result.authenticationInfo.newCounter } : null;
    } catch {
      return null;
    }
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Why passkeys cannot work at `baseUrl`, or null. Browsers refuse WebAuthn on
 * an IP-address RP id and outside a secure context (https, or localhost).
 */
export function passkeyBaseUrlProblem(baseUrl: string): string | null {
  const url = new URL(baseUrl);
  const host = url.hostname;
  if (LOCAL_HOSTS.has(host) || host.endsWith(".localhost")) return null;
  if (isIP(host.replace(/^\[|\]$/g, "")) !== 0) {
    return `BASE_URL host ${host} is an IP address; passkeys need a domain name`;
  }
  if (url.protocol !== "https:") {
    return `BASE_URL ${url.origin} is not https; browsers allow passkeys only on https (or localhost)`;
  }
  return null;
}
