/**
 * The OAuth 2.1 authorization server that lets an MCP client act for one
 * person on /mcp (MCP authorization, rev 2026-07-28). oidc-provider does all
 * of the protocol; this module configures it and adds WhereCtx's side:
 * consent decided from the scope registry, verifying an access token for
 * /mcp, and listing and revoking a person's grants.
 *
 * Shapes:
 * - The issuer is BASE_URL; the one protected resource is `${BASE_URL}/mcp`,
 *   and every access token is audience-bound to it. Every request reaches the
 *   provider as if it arrived at BASE_URL, whatever its Host and proxy headers
 *   say, so discovery, redirects and cookie flags never follow the request.
 * - Clients identify themselves with a Client ID Metadata Document (an https
 *   client_id the server fetches). Dynamic registration is opt-in.
 * - Every authorization shows consent, which needs a fresh passkey proof; a
 *   grant lasts 30 days, and a person holds at most one per client.
 */

import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import Provider, { errors, type Configuration, type Grant, type Interaction } from "oidc-provider";
import type { WhereCtxConfig } from "../config.js";
import { fail, hasFreshAuth, ok, type Actor, type Result } from "../accounts/types.js";
import { SECURITY_HEADERS } from "../app/securityHeaders.js";
import type { Clock } from "../util/time.js";
import type { OAuthKeys } from "../accounts/serverSecretsStore.js";
import type { UsersStore } from "../accounts/usersStore.js";
import { asUserId, type UserId } from "../types.js";
import {
  RESOURCE_SCOPES,
  consentGrants,
  parseOAuthScopes,
  type OAuthScope,
} from "./scopes.js";
import type { OAuthStore } from "./store.js";

const MINUTE = 60;
const DAY = 24 * 3600;
const ACCESS_TOKEN_TTL = 10 * MINUTE;
const GRANT_TTL = 30 * DAY;

export interface OAuthUrls {
  issuer: string;
  /** The canonical URI of the MCP endpoint, every access token's audience. */
  resource: string;
  /** Where /mcp's 401 points clients (RFC 9728). */
  resourceMetadata: string;
}

/** The OAuth URLs for BASE_URL, in canonical form (lower-case host, no default port). */
export function oauthUrls(baseUrl: string): OAuthUrls {
  const url = new URL(baseUrl);
  const issuer = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  return {
    issuer,
    resource: `${issuer}/mcp`,
    resourceMetadata: `${issuer}/.well-known/oauth-protected-resource/mcp`,
  };
}

/** What an access token presented to /mcp lets its client do. */
export interface OAuthAccess {
  userId: UserId;
  scope: string;
  grantId: string;
  clientId: string;
}

/** What the consent screen shows about a pending authorization. */
export interface ConsentRequest {
  client: { id: string; name: string | null; uri: string | null };
  redirectUri: string;
  redirectHost: string;
  /**
   * The browser goes back to a program on this device (loopback http or an
   * app's own URL scheme), so any local program could claim this client.
   */
  localhostOnly: boolean;
  requestedScopes: OAuthScope[];
  resource: string;
}

export interface ConnectedApp {
  id: string;
  clientId: string;
  clientName: string | null;
  scopes: OAuthScope[];
  createdAt: string;
  expiresAt: string | null;
}

export interface OAuthServerDeps {
  config: WhereCtxConfig;
  store: OAuthStore;
  users: UsersStore;
  keys: OAuthKeys;
  clock: Clock;
  /** Replaces the fetch that retrieves Client ID Metadata Documents (tests). */
  fetch?: typeof fetch;
}

/** Only an https redirect reaches a website; anything else lands on the person's device. */
const isLocalRedirect = (uri: string): boolean => {
  const url = URL.parse(uri);
  return url !== null && url.protocol !== "https:";
};

const asList = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string");

/** Whether a resource indicator names the MCP endpoint, in any spelling (case, trailing slash). */
function isResource(indicator: string, resource: string): boolean {
  const url = URL.parse(indicator);
  if (!url || url.search || url.hash) return false;
  return url.href.replace(/\/$/, "") === resource;
}

function providerConfig(deps: OAuthServerDeps, urls: OAuthUrls): Configuration {
  const resourceScope = RESOURCE_SCOPES.join(" ");
  return {
    adapter: deps.store.adapter,
    jwks: { keys: [{ ...deps.keys.signingKey, use: "sig", alg: "ES256" }] },
    cookies: { keys: [deps.keys.cookieKey] },
    scopes: [...RESOURCE_SCOPES, "offline_access"],
    responseTypes: ["code"],
    clientDefaults: {
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      id_token_signed_response_alg: "ES256",
    },
    pkce: { required: () => true },
    features: {
      devInteractions: { enabled: false },
      dPoP: { enabled: false },
      userinfo: { enabled: false },
      rpInitiatedLogout: { enabled: false },
      revocation: { enabled: true },
      introspection: { enabled: false },
      pushedAuthorizationRequests: { enabled: false },
      registration: { enabled: deps.config.oauth.dynamicRegistration },
      clientIdMetadataDocument: { enabled: true, ack: "draft-02" },
      resourceIndicators: {
        enabled: true,
        defaultResource: (_ctx, _client, oneOf) => oneOf?.[0] ?? urls.resource,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, indicator) => {
          if (!isResource(indicator, urls.resource)) throw new errors.InvalidTarget();
          return { scope: resourceScope, audience: urls.resource, accessTokenTTL: ACCESS_TOKEN_TTL, accessTokenFormat: "opaque" };
        },
      },
    },
    issueRefreshToken: (_ctx, client) => client.grantTypeAllowed("refresh_token"),
    // Tokens outlive the authorization server's own short browser session.
    expiresWithSession: () => false,
    // Consent comes from the grant this interaction just made, never an earlier one.
    loadExistingGrant: async (ctx) => {
      const grantId = ctx.oidc.result?.consent?.grantId;
      return grantId ? ctx.oidc.provider.Grant.find(grantId) : undefined;
    },
    findAccount: async (_ctx, sub) =>
      (await deps.users.get(asUserId(sub))) ? { accountId: sub, claims: () => ({ sub }) } : undefined,
    interactions: { url: (_ctx, interaction) => `/oauth/interaction/${interaction.uid}` },
    renderError: (ctx, out) => {
      ctx.type = "json";
      ctx.body = out;
    },
    routes: {
      authorization: "/oauth/authorize",
      token: "/oauth/token",
      revocation: "/oauth/revoke",
      jwks: "/oauth/jwks",
      registration: "/oauth/register",
      introspection: "/oauth/introspect",
      userinfo: "/oauth/userinfo",
      end_session: "/oauth/logout",
      pushed_authorization_request: "/oauth/par",
      device_authorization: "/oauth/device/auth",
      code_verification: "/oauth/device",
      backchannel_authentication: "/oauth/backchannel",
      challenge: "/oauth/challenge",
      credential: "/oauth/credential",
    },
    ttl: {
      AccessToken: ACCESS_TOKEN_TTL,
      AuthorizationCode: MINUTE,
      RefreshToken: GRANT_TTL,
      Grant: GRANT_TTL,
      Interaction: 10 * MINUTE,
      Session: 10 * MINUTE,
    },
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  };
}

export class OAuthServer {
  readonly provider: Provider;
  readonly urls: OAuthUrls;

  /** The Node listener for the protocol endpoints (app/listener.ts routes them here). */
  readonly handler: RequestListener;
  private readonly issuerUrl: URL;

  constructor(private readonly deps: OAuthServerDeps) {
    this.urls = oauthUrls(deps.config.baseUrl);
    this.issuerUrl = new URL(this.urls.issuer);
    this.provider = new Provider(this.urls.issuer, providerConfig(deps, this.urls));
    // The provider reads its origin from the forwarded headers `atIssuer`
    // overwrites, never from the client. TRUST_PROXY only picks the client IP.
    this.provider.proxy = true;
    this.provider.use(async (ctx, next) => {
      ctx.set(SECURITY_HEADERS);
      await next();
    });
    const callback = this.provider.callback();
    this.handler = (req, res) => {
      this.atIssuer(req);
      void callback(req, res);
    };
  }

  private atIssuer(req: IncomingMessage): void {
    req.headers["x-forwarded-proto"] = this.issuerUrl.protocol.slice(0, -1);
    req.headers["x-forwarded-host"] = this.issuerUrl.host;
  }

  /** RFC 9728 metadata for /mcp. */
  protectedResourceMetadata() {
    return {
      resource: this.urls.resource,
      authorization_servers: [this.urls.issuer],
      scopes_supported: RESOURCE_SCOPES,
      bearer_methods_supported: ["header"],
      resource_name: "WhereCtx",
    };
  }

  async verifyAccessToken(value: string): Promise<OAuthAccess | null> {
    const token = await this.provider.AccessToken.find(value);
    if (!token || token.isExpired || !asList(token.aud).includes(this.urls.resource)) return null;
    const grant = await this.provider.Grant.find(token.grantId);
    if (!grant || grant.accountId !== token.accountId || grant.clientId !== token.clientId) return null;
    const user = await this.deps.users.get(asUserId(token.accountId));
    if (!user || !token.clientId) return null;
    return { userId: user.id, scope: token.scope ?? "", grantId: token.grantId, clientId: token.clientId };
  }

  /**
   * The pending authorization `uid` names, if this browser started it, it has
   * not expired, and nobody has answered it yet.
   */
  private async interaction(req: IncomingMessage, res: ServerResponse, uid: string): Promise<Interaction | null> {
    this.atIssuer(req);
    try {
      const interaction = await this.provider.interactionDetails(req, res);
      return interaction.uid === uid && !interaction.result ? interaction : null;
    } catch (e) {
      if (e instanceof errors.SessionNotFound) return null;
      throw e;
    }
  }

  async consentRequest(req: IncomingMessage, res: ServerResponse, uid: string): Promise<ConsentRequest | null> {
    const interaction = await this.interaction(req, res, uid);
    if (!interaction) return null;
    const client = await this.provider.Client.find(String(interaction.params.client_id));
    if (!client) return null;
    const redirectUri = String(interaction.params.redirect_uri ?? client.redirectUris?.[0] ?? "");
    return {
      client: { id: client.clientId, name: client.clientName ?? null, uri: client.clientUri ?? null },
      redirectUri,
      redirectHost: URL.parse(redirectUri)?.host || redirectUri,
      localhostOnly: isLocalRedirect(redirectUri),
      requestedScopes: parseOAuthScopes(String(interaction.params.scope ?? "")),
      resource: this.urls.resource,
    };
  }

  /**
   * Record the person's consent as a fresh grant, replacing any earlier grant
   * to the same client, and finish the interaction. Returns where the browser
   * goes next (back into the authorization flow); `not_found` when the
   * interaction is gone or already answered.
   */
  async consent(
    actor: Actor,
    req: IncomingMessage,
    res: ServerResponse,
    uid: string,
    optedIn: ReadonlySet<OAuthScope>,
  ): Promise<Result<string>> {
    // Consent mints a 30-day credential, like POST /v1/tokens, so a stolen
    // session cookie alone must not be enough.
    if (!hasFreshAuth(actor.reauthAt, this.deps.clock())) {
      return fail("reauth_required", "confirm with your passkey first (POST /v1/me/reauth)");
    }
    const { userId } = actor;
    const interaction = await this.interaction(req, res, uid);
    if (!interaction) return fail("not_found", "authorization request not found");
    const { params } = interaction;
    const clientId = String(params.client_id);
    const requested = String(params.scope ?? "").split(" ").filter(Boolean);
    const granted = requested.filter((s) => consentGrants(s, optedIn));
    const rejected = requested.filter((s) => !granted.includes(s));

    const grant = new this.provider.Grant({ accountId: userId, clientId });
    // The provider checks consent per scope list it knows: its static scopes
    // and each requested resource indicator, so the decision goes on both.
    grant.addOIDCScope(granted);
    if (rejected.length) grant.rejectOIDCScope(rejected);
    const indicators = asList(params.resource);
    for (const indicator of indicators.length ? indicators : [this.urls.resource]) {
      grant.addResourceScope(indicator, granted);
      if (rejected.length) grant.rejectResourceScope(indicator, rejected);
    }
    const grantId = await grant.save();
    const client = await this.provider.Client.find(clientId);
    if (client?.clientName) await this.deps.store.nameGrant(grantId, client.clientName);

    const redirectTo = await this.provider.interactionResult(
      req,
      res,
      { login: { accountId: userId }, consent: { grantId } },
      { mergeWithLastSubmission: false },
    );
    for (const earlier of await this.grantsOf(userId)) {
      if (earlier.grant.jti !== grantId && earlier.clientId === clientId) await this.revoke(earlier.grant);
    }
    return ok(redirectTo);
  }

  async deny(req: IncomingMessage, res: ServerResponse, uid: string): Promise<string | null> {
    if (!(await this.interaction(req, res, uid))) return null;
    return this.provider.interactionResult(
      req,
      res,
      { error: "access_denied", error_description: "The person declined to connect this app." },
      { mergeWithLastSubmission: false },
    );
  }

  /** A person's live grants with the client name stored at consent, oldest first. */
  private async grantsOf(userId: UserId): Promise<Array<{ grant: Grant; clientId: string; clientName: string | null }>> {
    const grants = [];
    for (const { id, clientName } of await this.deps.store.grantsOf(userId)) {
      const grant = await this.provider.Grant.find(id);
      if (grant?.clientId && grant.accountId === userId) grants.push({ grant, clientId: grant.clientId, clientName });
    }
    return grants;
  }

  async connectedApps(actor: Actor): Promise<ConnectedApp[]> {
    const apps: ConnectedApp[] = [];
    for (const { grant, clientId, clientName } of await this.grantsOf(actor.userId)) {
      const scopes = Object.keys(grant.resources ?? {}).map((r) => grant.getResourceScope(r)).join(" ");
      apps.push({
        id: grant.jti,
        clientId,
        clientName,
        scopes: parseOAuthScopes(scopes),
        createdAt: new Date(grant.iat * 1000).toISOString(),
        expiresAt: grant.exp ? new Date(grant.exp * 1000).toISOString() : null,
      });
    }
    return apps;
  }

  /** Revoke one of the person's grants and every code and token issued under it. */
  async disconnect(actor: Actor, grantId: string): Promise<boolean> {
    const grant = await this.provider.Grant.find(grantId);
    if (!grant || grant.accountId !== actor.userId) return false;
    await this.revoke(grant);
    return true;
  }

  private async revoke(grant: Grant): Promise<void> {
    const { AccessToken, RefreshToken, AuthorizationCode } = this.provider;
    await Promise.all([
      grant.destroy(),
      AccessToken.revokeByGrantId(grant.jti),
      RefreshToken.revokeByGrantId(grant.jti),
      AuthorizationCode.revokeByGrantId(grant.jti),
    ]);
  }
}
