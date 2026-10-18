/**
 * A software WebAuthn authenticator for tests: real ES256 keys (node:crypto),
 * real authenticator data and CBOR, 'none' attestation. It lets tests drive
 * SimpleWebAuthnCeremony end to end, including what a browser would refuse to
 * produce (another origin or RP id, no user verification, a stale counter).
 * Excluded from the production build (tsconfig).
 */

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor>;

function cborHead(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

/** The subset of CBOR (RFC 8949) WebAuthn attestation objects and COSE keys use. */
export function cbor(value: Cbor): Buffer {
  if (typeof value === "number") {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([cborHead(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([cborHead(4, value.length), ...value.map(cbor)]);
  const entries = [...value.entries()];
  return Buffer.concat([cborHead(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)])]);
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest();
const b64url = (data: Buffer) => data.toString("base64url");

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export interface AuthenticatorContext {
  /** The page origin the browser would report. */
  origin: string;
  /** The RP id the authenticator scopes the credential to; defaults to the origin's host. */
  rpId?: string;
  /** Whether the user was verified (biometric/PIN); defaults to true. */
  userVerified?: boolean;
}

interface Credential {
  id: Buffer;
  privateKey: KeyObject;
  rpId: string;
  userHandle: string;
  counter: number;
}

export class SoftAuthenticator {
  private readonly credentials = new Map<string, Credential>();

  create(
    options: { challenge: string; user: { id: string } },
    context: AuthenticatorContext,
  ): RegistrationResponseJSON {
    const rpId = context.rpId ?? new URL(context.origin).hostname;
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const coseKey = cbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, "base64url")],
        [-3, Buffer.from(jwk.y!, "base64url")],
      ]),
    );
    const id = randomBytes(16);
    const credential: Credential = { id, privateKey, rpId, userHandle: options.user.id, counter: 0 };
    this.credentials.set(b64url(id), credential);

    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(id.length);
    const authData = Buffer.concat([
      this.authDataHead(credential, context, FLAG_AT),
      Buffer.alloc(16),
      idLength,
      id,
      coseKey,
    ]);
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    return {
      id: b64url(id),
      rawId: b64url(id),
      type: "public-key",
      response: {
        clientDataJSON: this.clientData("webauthn.create", options.challenge, context),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
    };
  }

  get(
    options: { challenge: string },
    credentialId: string,
    context: AuthenticatorContext & { counter?: number },
  ): AuthenticationResponseJSON {
    const credential = this.credentials.get(credentialId);
    if (!credential) throw new Error(`unknown credential ${credentialId}`);
    credential.counter = context.counter ?? credential.counter + 1;
    const authData = this.authDataHead(credential, context, 0);
    const clientDataJSON = this.clientData("webauthn.get", options.challenge, context);
    const signature = sign(
      "sha256",
      Buffer.concat([authData, sha256(Buffer.from(clientDataJSON, "base64url"))]),
      credential.privateKey,
    );
    return {
      id: credentialId,
      rawId: credentialId,
      type: "public-key",
      response: {
        clientDataJSON,
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: credential.userHandle,
      },
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
    };
  }

  private authDataHead(credential: Credential, context: AuthenticatorContext, extra: number): Buffer {
    const flags = FLAG_UP | (context.userVerified === false ? 0 : FLAG_UV) | extra;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(credential.counter);
    return Buffer.concat([sha256(context.rpId ?? credential.rpId), Buffer.from([flags]), counter]);
  }

  private clientData(type: string, challenge: string, context: AuthenticatorContext): string {
    return b64url(
      Buffer.from(JSON.stringify({ type, challenge, origin: context.origin, crossOrigin: false })),
    );
  }
}
