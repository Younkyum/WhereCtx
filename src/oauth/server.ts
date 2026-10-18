/**
 * The OAuth 2.1 authorization server that lets an MCP client act for one
 * person on /mcp (MCP authorization, rev 2026-07-28). oidc-provider does all
 * of the protocol; this module configures it and adds WhereCtx's side:
 * consent decided from the scope registry, verifying an access token for
 * /mcp, and listing and revoking a person's grants.
 *
 * Shapes:
 * - The issuer is BASE_URL; the one protected resource is `${BASE_URL}/mcp`,
 *   and every access token is audience-bound to it.
 * - Clients identify themselves with a Client ID Metadata Document (an https
 *   client_id the server fetches). Dynamic registration is opt-in.
 * - Every authorization shows consent; a grant lasts 30 days.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import Provider, { errors, type Configuration, type Interaction } from "oidc-provider";
import type { WhereCtxConfig } from "../config.js";
import type { Actor } from "../accounts/types.js";
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

export function oauthUrls(baseUrl: string): OAuthUrls {
  return {
    issuer: baseUrl,
    resource: `${baseUrl}/mcp`,
    resourceMetadata: `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
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
  /** Every redirect URI is on this machine, so any local program could claim this name. */
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
  /** Replaces the fetch that retrieves Client ID Metadata Documents (tests). */
  fetch?: typeof fetch;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const isLoopback = (uri: string): boolean => LOOPBACK_HOSTS.has(URL.parse(uri)?.hostname ?? "");

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

  constructor(private readonly deps: OAuthServerDeps) {
    this.urls = oauthUrls(deps.config.baseUrl);
    this.provider = new Provider(this.urls.issuer, providerConfig(deps, this.urls));
    this.provider.proxy = deps.config.trustProxy !== "none";
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

  /** The pending authorization `uid` names, if this browser started it and it has not expired. */
  private async interaction(req: IncomingMessage, res: ServerResponse, uid: string): Promise<Interaction | null> {
    try {
      const interaction = await this.provider.interactionDetails(req, res);
      return interaction.uid === uid ? interaction : null;
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
      redirectHost: URL.parse(redirectUri)?.host ?? redirectUri,
      localhostOnly: (client.redirectUris ?? []).every(isLoopback),
      requestedScopes: parseOAuthScopes(String(interaction.params.scope ?? "")),
      resource: this.urls.resource,
    };
  }

  /**
   * Record the person's consent as a fresh grant and finish the interaction.
   * Returns where the browser goes next (back into the authorization flow).
   */
  async consent(
    { userId }: Actor,
    req: IncomingMessage,
    res: ServerResponse,
    uid: string,
    optedIn: ReadonlySet<OAuthScope>,
  ): Promise<string | null> {
    const interaction = await this.interaction(req, res, uid);
    if (!interaction) return null;
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

    return this.provider.interactionResult(
      req,
      res,
      { login: { accountId: userId }, consent: { grantId } },
      { mergeWithLastSubmission: false },
    );
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

  async connectedApps(actor: Actor): Promise<ConnectedApp[]> {
    const rows = await this.deps.store.grantsOf(actor.userId);
    const apps: ConnectedApp[] = [];
    for (const row of rows) {
      const grant = await this.provider.Grant.find(row.id);
      if (!grant?.clientId) continue;
      const scopes = Object.keys(grant.resources ?? {}).map((r) => grant.getResourceScope(r)).join(" ");
      apps.push({
        id: row.id,
        clientId: grant.clientId,
        clientName: row.clientName,
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
    const { AccessToken, RefreshToken, AuthorizationCode } = this.provider;
    await Promise.all([
      grant.destroy(),
      AccessToken.revokeByGrantId(grantId),
      RefreshToken.revokeByGrantId(grantId),
      AuthorizationCode.revokeByGrantId(grantId),
    ]);
    return true;
  }
}
