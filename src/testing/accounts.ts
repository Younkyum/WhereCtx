/**
 * Test support for the account layer: a fake WebAuthn ceremony, a matching
 * fake authenticator, and a cookie-holding client that drives the real HTTP
 * app. The fake keeps WebAuthn's essential checks (the challenge must match
 * the ceremony; an assertion must be signed by the stored key) without crypto.
 * Excluded from the production build (tsconfig).
 */

import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { WhereCtxConfig } from "../config.js";
import { createAppContext, type AppContext, type AppContextOptions } from "../app/context.js";
import { buildApp, type BuildAppOptions } from "../app/server.js";
import type { PasskeyCeremony } from "../accounts/passkeys.js";
import type { StoredPasskey } from "../accounts/passkeysStore.js";
import type { RegistrationSubject } from "../accounts/usersStore.js";
import { asUserId } from "../types.js";

export const BASE_URL = "http://localhost:8787";
/** A BASE_URL a phone could reach, for tests that pair devices. */
export const PUBLIC_BASE_URL = "https://where.example.com";

export function testConfig(overrides: Partial<WhereCtxConfig> = {}): WhereCtxConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    baseUrl: BASE_URL,
    databaseUrl: ":memory:",
    defaultUserId: asUserId("owner"),
    bootstrapTokens: {},
    privacy: {
      defaultAgentAccess: "coarse",
      preciseRequiresReason: true,
      allowPreciseToAgent: false,
      hideHomeExactCoordinates: true,
      protectHomePlace: true,
      staleAfterSec: 900,
      deviceOfflineAfterSec: 86_400,
      retentionHours: 24,
      storeRawHistory: false,
    },
    geofence: { nearRadiusMultiplier: 3 },
    trustProxy: "none",
    allowMemberWorkspaces: true,
    webhooks: { allowPrivateTargets: true },
    events: { retentionHours: 720 },
    sharing: { auditRetentionDays: 365 },
    oauth: { dynamicRegistration: false },
    geo: { operatorMapKeys: {}, operatorKeys: {}, operatorKeyForAll: false, operatorMapKeyForAll: false, operatorDailyCap: 200, fake: false },
    activity: { accessLogRetentionDays: 90, ingestLogRetentionDays: 7 },
    ...overrides,
  };
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");
const randomB64 = () => randomBytes(16).toString("base64url");
const signatureFor = (publicKey: string) => b64(`signed-by:${publicKey}`);

function clientData(response: { response: { clientDataJSON: string } }): {
  type?: string;
  challenge?: string;
} {
  try {
    return JSON.parse(unb64(response.response.clientDataJSON));
  } catch {
    return {};
  }
}

export class FakeCeremony implements PasskeyCeremony {
  async registrationOptions(subject: RegistrationSubject, exclude: readonly string[]) {
    return {
      challenge: randomB64(),
      rp: { name: "WhereCtx", id: "localhost" },
      user: {
        id: Buffer.from(subject.handle, "hex").toString("base64url"),
        name: subject.name,
        displayName: subject.name,
      },
      pubKeyCredParams: [{ alg: -7, type: "public-key" }],
      excludeCredentials: exclude.map((id) => ({ id, type: "public-key" })),
    } satisfies PublicKeyCredentialCreationOptionsJSON;
  }

  async verifyRegistration(response: RegistrationResponseJSON, expectedChallenge: string) {
    const data = clientData(response);
    if (data.type !== "webauthn.create" || data.challenge !== expectedChallenge) return null;
    return {
      credentialId: response.id,
      publicKey: b64(`pk:${response.id}`),
      counter: 0,
      transports: ["internal" as const],
    };
  }

  async authenticationOptions(allow?: readonly string[]) {
    return {
      challenge: randomB64(),
      rpId: "localhost",
      userVerification: "required",
      allowCredentials: allow?.map((id) => ({ id, type: "public-key" as const })),
    } satisfies PublicKeyCredentialRequestOptionsJSON;
  }

  async verifyAuthentication(
    response: AuthenticationResponseJSON,
    expectedChallenge: string,
    credential: StoredPasskey,
  ) {
    const data = clientData(response);
    if (data.type !== "webauthn.get" || data.challenge !== expectedChallenge) return null;
    if (response.response.signature !== signatureFor(credential.publicKey)) return null;
    return { newCounter: credential.counter + 1 };
  }
}

/** What a browser's authenticator would return from navigator.credentials. */
export const authenticator = {
  create(options: { challenge: string }): RegistrationResponseJSON {
    const id = randomB64();
    return {
      id,
      rawId: id,
      type: "public-key",
      response: {
        clientDataJSON: b64(JSON.stringify({ type: "webauthn.create", challenge: options.challenge })),
        attestationObject: b64("attestation"),
        transports: ["internal"],
      },
      clientExtensionResults: {},
    };
  },
  get(options: { challenge: string }, credentialId: string): AuthenticationResponseJSON {
    return {
      id: credentialId,
      rawId: credentialId,
      type: "public-key",
      response: {
        clientDataJSON: b64(JSON.stringify({ type: "webauthn.get", challenge: options.challenge })),
        authenticatorData: b64("authdata"),
        signature: signatureFor(b64(`pk:${credentialId}`)),
      },
      clientExtensionResults: {},
    };
  },
};

export interface SendOptions {
  method?: string;
  body?: unknown;
  /** Origin header; defaults to the server's own origin. `null` omits it. */
  origin?: string | null;
  bearer?: string;
}

const SESSION_COOKIE = /(?:__Host-)?wctx_session=([^;]*)/;

/** A browser tab: keeps the session cookie and sends the page's Origin. */
export class Browser {
  cookie: string | undefined;
  lastSetCookie: string | null = null;

  constructor(
    private readonly app: Hono,
    private readonly baseUrl: string = BASE_URL,
  ) {}

  async send(path: string, opts: SendOptions = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    const secure = this.baseUrl.startsWith("https:");
    if (this.cookie) headers.cookie = `${secure ? "__Host-" : ""}wctx_session=${this.cookie}`;
    const origin = opts.origin === undefined ? new URL(this.baseUrl).origin : opts.origin;
    if (origin !== null) headers.origin = origin;
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await this.app.request(path, {
      method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    this.lastSetCookie = res.headers.get("set-cookie");
    const m = this.lastSetCookie && SESSION_COOKIE.exec(this.lastSetCookie);
    if (m) this.cookie = m[1] && !/Max-Age=0/i.test(this.lastSetCookie!) ? m[1] : undefined;
    return res;
  }

  async json(path: string, opts: SendOptions = {}): Promise<any> {
    const res = await this.send(path, opts);
    const body = await res.json();
    if (!res.ok) throw new Error(`${opts.method ?? "GET"} ${path} -> ${res.status} ${JSON.stringify(body)}`);
    return body;
  }
}

export interface Enrolled {
  browser: Browser;
  credentialId: string;
  userId: string;
  recoveryCodes: string[];
}

export async function setupOwner(app: Hono, code: string, baseUrl = BASE_URL): Promise<Enrolled> {
  const browser = new Browser(app, baseUrl);
  const start = await browser.json("/v1/auth/setup/options", { body: { code } });
  const response = authenticator.create(start.options);
  const done = await browser.json("/v1/auth/setup/verify", {
    body: { code, ceremony: start.ceremony, response },
  });
  return { browser, credentialId: response.id, userId: done.userId, recoveryCodes: done.recoveryCodes };
}

export async function login(app: Hono, credentialId: string, browser = new Browser(app)): Promise<Browser> {
  const start = await browser.json("/v1/auth/login/options", { body: {} });
  await browser.json("/v1/auth/login/verify", {
    body: { ceremony: start.ceremony, response: authenticator.get(start.options, credentialId) },
  });
  return browser;
}

/** Prove the passkey again so step-up operations are allowed. */
export async function reauth(browser: Browser, credentialId: string): Promise<void> {
  const start = await browser.json("/v1/me/reauth/options", { body: {} });
  await browser.json("/v1/me/reauth/verify", {
    body: { ceremony: start.ceremony, response: authenticator.get(start.options, credentialId) },
  });
}

/** Sign up through an invite URL; returns the raw verify response. */
export async function signUpByInvite(
  app: Hono,
  inviteUrl: string,
  displayName: string,
  baseUrl = BASE_URL,
): Promise<{ browser: Browser; res: Response; credentialId: string }> {
  const token = inviteToken(inviteUrl);
  const browser = new Browser(app, baseUrl);
  const start = await browser.send("/v1/auth/invite/options", { body: { token, displayName } });
  if (!start.ok) return { browser, res: start, credentialId: "" };
  const { ceremony, options } = (await start.json()) as any;
  const response = authenticator.create(options);
  const res = await browser.send("/v1/auth/invite/verify", {
    body: { token, ceremony, response },
  });
  return { browser, res, credentialId: response.id };
}

export function inviteToken(inviteUrl: string): string {
  const m = /#invite=([A-Za-z0-9_-]+)$/.exec(inviteUrl);
  if (!m) throw new Error(`not an invite url: ${inviteUrl}`);
  return m[1]!;
}

export const OWNER_ADMIN = "owner-admin-token-strong-0123456789abcdef";

/** A settable clock shared by a test and the app it boots. */
export class TestClock {
  now = Date.parse("2026-10-18T00:00:00.000Z");
  readonly fn = () => new Date(this.now);
  advance(ms: number): void {
    this.now += ms;
  }
}

export interface BootedApp {
  ctx: AppContext;
  app: Hono;
  setupCode: string;
}

/** Boot the real app on an in-memory database with the fake ceremony and an admin token. */
export async function bootApp(
  clock: TestClock,
  overrides: Partial<WhereCtxConfig> = {},
  build: BuildAppOptions = {},
  options: Pick<AppContextOptions, "oauthFetch" | "geoFetch" | "geoSchedule"> = {},
): Promise<BootedApp> {
  const { ctx, bootstrap } = await createAppContext(
    testConfig({ bootstrapTokens: { admin: OWNER_ADMIN }, ...overrides }),
    { clock: clock.fn, ceremony: new FakeCeremony(), ...options },
  );
  return { ctx, app: buildApp(ctx, build), setupCode: bootstrap.setupCode!.reveal() };
}
