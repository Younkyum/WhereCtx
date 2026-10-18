/**
 * The passkey ceremonies behind the sign-in screens and "add a passkey". Each
 * asks the server for options, runs navigator.credentials, and sends the
 * result back; the server sets the session cookie on success.
 */

import { api, createPasskey, getPasskey } from "./api";
import { deviceLabel, type CreationOptionsJSON, type RequestOptionsJSON } from "./lib";
import type { CeremonyStart } from "./model";

type Enrolled = { recoveryCodes: string[] };

function passkeyName(): string | undefined {
  return deviceLabel(navigator.userAgent) || undefined;
}

export async function signIn(): Promise<void> {
  const start = await api<CeremonyStart<RequestOptionsJSON>>("/v1/auth/login/options", { method: "POST", public: true });
  const response = await getPasskey(start.options);
  await api("/v1/auth/login/verify", { body: { ceremony: start.ceremony, response }, public: true });
}

/** First-time setup: the owner's passkey, then their name (a failed rename does not undo the setup). */
export async function setUpOwner(code: string, displayName: string): Promise<Enrolled & { renamed: boolean }> {
  const start = await api<CeremonyStart<CreationOptionsJSON>>("/v1/auth/setup/options", { body: { code }, public: true });
  const response = await createPasskey(start.options);
  const done = await api<Enrolled>("/v1/auth/setup/verify", {
    body: { code, ceremony: start.ceremony, response, passkeyName: passkeyName() },
    public: true,
  });
  const renamed = await api("/v1/me", { method: "PATCH", body: { displayName } }).then(
    () => true,
    () => false,
  );
  return { recoveryCodes: done.recoveryCodes, renamed };
}

export async function joinByInvite(token: string, displayName: string): Promise<Enrolled> {
  const start = await api<CeremonyStart<CreationOptionsJSON>>("/v1/auth/invite/options", {
    body: { token, displayName },
    public: true,
  });
  const response = await createPasskey(start.options);
  return api<Enrolled>("/v1/auth/invite/verify", {
    body: { token, ceremony: start.ceremony, response, passkeyName: passkeyName() },
    public: true,
  });
}

export async function enrollWithAccessCode(code: string): Promise<Enrolled> {
  const start = await api<CeremonyStart<CreationOptionsJSON>>("/v1/auth/access-code/options", { body: { code }, public: true });
  const response = await createPasskey(start.options);
  return api<Enrolled>("/v1/auth/access-code/verify", {
    body: { code, ceremony: start.ceremony, response, passkeyName: passkeyName() },
    public: true,
  });
}

export async function recover(code: string): Promise<void> {
  await api("/v1/auth/recover", { body: { code }, public: true });
}

/** Register another passkey for the signed-in person (the step-up, if asked for, runs inside api()). */
export async function addPasskey(): Promise<void> {
  const start = await api<CeremonyStart<CreationOptionsJSON>>("/v1/me/passkeys/options", { method: "POST" });
  const response = await createPasskey(start.options);
  await api("/v1/me/passkeys/verify", { body: { ceremony: start.ceremony, response, name: passkeyName() } });
}
