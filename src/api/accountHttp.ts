/**
 * HTTP plumbing shared by the account routers: JSON body parsing with zod, the
 * account-error to status table, and the WebAuthn response shapes.
 *
 * WebAuthn bodies are checked structurally here (strings are base64url, the
 * required members exist) and then handed to the ceremony, which does the
 * cryptographic verification.
 */

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { AccountErrorCode, Result } from "../accounts/types.js";
import { WORKSPACE_ROLES } from "../accounts/types.js";
import { CEREMONY_STATE_PATTERN } from "../accounts/ceremonies.js";
import { zodMessages } from "./validation.js";

export const ACCOUNT_ERROR_STATUS: Record<AccountErrorCode, ContentfulStatusCode> = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  last_owner: 409,
  last_passkey: 409,
  gone: 410,
  reauth_required: 403,
};

/**
 * Send `result`'s error, or render its value with `render`. The error body
 * carries the machine-readable `code` so a client can tell, say, a needed
 * re-authentication from a plain refusal.
 */
export function respond<T>(
  c: Context,
  result: Result<T>,
  render: (value: T) => Response | Promise<Response>,
): Response | Promise<Response> {
  if (!result.ok) {
    return c.json({ error: result.message, code: result.code }, ACCOUNT_ERROR_STATUS[result.code]);
  }
  return render(result.value);
}

/** Parse the JSON body with `schema`, or return the 400 response to send. */
export async function parseBody<S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<z.infer<S> | Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "request body must be valid JSON" }, 400);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid request", detail: zodMessages(parsed.error) }, 400);
  }
  return parsed.data;
}

export const DisplayName = z.string().trim().min(1).max(64);
export const PasskeyName = z.string().trim().min(1).max(64).optional();
export const Role = z.enum(WORKSPACE_ROLES);
export const CeremonyState = z.string().regex(CEREMONY_STATE_PATTERN, "must be a ceremony state");
/** Any short string: an unknown token must reach the lookup and count as a 401. */
export const InviteToken = z.string().min(1).max(128);

const base64url = z.string().regex(/^[A-Za-z0-9_-]*$/, "must be base64url");

const KNOWN_TRANSPORTS: ReadonlySet<string> = new Set<AuthenticatorTransportFuture>([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]);

const credentialFields = {
  id: base64url.min(1),
  rawId: base64url.min(1),
  type: z.literal("public-key"),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
};

export const RegistrationResponse = z
  .object({
    ...credentialFields,
    response: z.looseObject({
      clientDataJSON: base64url,
      attestationObject: base64url,
      authenticatorData: base64url.optional(),
      publicKey: base64url.optional(),
      publicKeyAlgorithm: z.number().optional(),
      transports: z
        .array(z.string())
        .max(16)
        .transform((ts) => ts.filter((t) => KNOWN_TRANSPORTS.has(t)))
        .optional(),
    }),
  })
  .transform((r) => r as RegistrationResponseJSON);

export const AuthenticationResponse = z
  .object({
    ...credentialFields,
    response: z.looseObject({
      clientDataJSON: base64url,
      authenticatorData: base64url,
      signature: base64url,
      userHandle: base64url.optional(),
    }),
  })
  .transform((r) => r as AuthenticationResponseJSON);
