/**
 * The API client. Every call is same-origin JSON with the session cookie.
 *
 * Error policy: a 401 without a code means the session is gone, so the app
 * returns to sign-in (account refusals always carry a code). `public` marks the
 * sign-in calls, whose 401 means a wrong code instead. A 403 `reauth_required`
 * runs the passkey step-up and retries the call once.
 */

import {
  authenticationToJSON,
  creationOptionsFromJSON,
  registrationToJSON,
  requestOptionsFromJSON,
  type ApiErrorInfo,
  type CreationOptionsJSON,
  type CredentialLike,
  type RequestOptionsJSON,
} from "./lib";
import type { CeremonyStart } from "./model";

export class ApiError extends Error implements ApiErrorInfo {
  readonly status: number;
  readonly code: string | null;
  /** What the server said was wrong with the request, in its words; empty when it sent none. */
  readonly detail: string[];
  /** True once the app has already responded (signed out); callers show nothing more. */
  handled = false;

  constructor(status: number, data: { error?: unknown; code?: unknown; detail?: unknown }) {
    super(typeof data.error === "string" ? data.error : `HTTP ${status}`);
    this.status = status;
    this.code = typeof data.code === "string" ? data.code : null;
    this.detail = Array.isArray(data.detail) ? data.detail.filter((d): d is string => typeof d === "string") : [];
  }
}

export function isHandled(e: unknown): boolean {
  return e instanceof ApiError && e.handled;
}

interface Hooks {
  onSignedOut: () => void;
  onReauth: () => void;
}

const hooks: Hooks = { onSignedOut: () => {}, onReauth: () => {} };

/** The app wires what a lost session and a step-up prompt look like. */
export function setApiHooks(next: Partial<Hooks>): void {
  Object.assign(hooks, next);
}

export interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  public?: boolean;
  retried?: boolean;
}

export async function api<T = Record<string, unknown>>(path: string, opts: ApiOptions = {}): Promise<T> {
  const init: RequestInit = {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    headers: opts.body === undefined ? {} : { "content-type": "application/json" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  };
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, { code: "network" });
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
  }
  if (res.ok) return data as T;
  const err = new ApiError(res.status, data);
  if (res.status === 401 && !err.code && !opts.public) {
    err.handled = true;
    hooks.onSignedOut();
    throw err;
  }
  if (res.status === 403 && err.code === "reauth_required" && !opts.retried) {
    await reauth();
    return api<T>(path, { ...opts, retried: true });
  }
  throw err;
}

export async function createPasskey(options: CreationOptionsJSON) {
  const cred = await navigator.credentials.create({ publicKey: creationOptionsFromJSON(options) });
  return registrationToJSON(cred as unknown as CredentialLike);
}

export async function getPasskey(options: RequestOptionsJSON) {
  const cred = await navigator.credentials.get({ publicKey: requestOptionsFromJSON(options) });
  return authenticationToJSON(cred as unknown as CredentialLike);
}

/** Prove a passkey again (step-up); the caller retries its request after this. */
export async function reauth(): Promise<void> {
  hooks.onReauth();
  const start = await api<CeremonyStart<RequestOptionsJSON>>("/v1/me/reauth/options", { method: "POST", retried: true });
  const response = await getPasskey(start.options);
  await api("/v1/me/reauth/verify", { body: { ceremony: start.ceremony, response }, retried: true });
}
