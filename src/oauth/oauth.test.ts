import { createHash, randomBytes } from "node:crypto";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppContext } from "../app/context.js";
import { createListener } from "../app/listener.js";
import { RateLimiter } from "../api/rateLimit.js";
import type { WhereCtxConfig } from "../config.js";
import { OWNER_ADMIN, TestClock, bootApp, setupOwner, signUpByInvite, type Enrolled } from "../testing/accounts.js";
import { asUserId, type NormalizedReading } from "../types.js";

const CLIENT_ID = "https://client.example/meta.json";
const REDIRECT = "http://127.0.0.1:9876/cb";
const CLIENT_METADATA = {
  client_id: CLIENT_ID,
  client_name: "Test Agent",
  client_uri: "https://client.example",
  redirect_uris: [REDIRECT],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};
/** A bootstrap agent token: no `wctx_` prefix, like one set through AGENT_TOKEN. */
const BOOTSTRAP_AGENT = "agent-token-strong-0123456789abcdef";

const metadataFetch: typeof fetch = async (input) =>
  String(input) === CLIENT_ID
    ? new Response(JSON.stringify(CLIENT_METADATA), { status: 200, headers: { "content-type": "application/json" } })
    : new Response("not found", { status: 404 });

let clock: TestClock;
let ctx: AppContext;
let server: Server;
let base: string;
let resource: string;
let owner: Enrolled;
let app: Awaited<ReturnType<typeof bootApp>>["app"];

async function boot(overrides: Partial<WhereCtxConfig> = {}): Promise<void> {
  let listener: RequestListener = (_req, res) => res.end();
  server = createServer((req, res) => listener(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  resource = `${base}/mcp`;
  const booted = await bootApp(
    clock,
    { baseUrl: base, bootstrapTokens: { admin: OWNER_ADMIN, agent: BOOTSTRAP_AGENT }, ...overrides },
    {},
    { oauthFetch: metadataFetch },
  );
  ({ ctx, app } = booted);
  listener = createListener(ctx, { authLimiter: new RateLimiter() });
  owner = await setupOwner(app, booted.setupCode, base);
}

async function shutdown(): Promise<void> {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  ctx.handle.client.close();
}

beforeEach(async () => {
  clock = new TestClock();
  await boot();
});

afterEach(shutdown);

interface StoredCookie {
  value: string;
  path: string;
}

/** A browser against the real server: follows cookie paths and deletions, never redirects. */
class UserAgent {
  private readonly jar = new Map<string, StoredCookie>();

  constructor(sessionSecret?: string) {
    if (sessionSecret) this.jar.set("wctx_session", { value: sessionSecret, path: "/" });
  }

  /** `cookiesOf` sends the cookies another path would get, as a hand-made request could. */
  async request(
    path: string,
    init: { method?: string; json?: unknown; origin?: string; cookiesOf?: string } = {},
  ): Promise<Response> {
    const url = new URL(path, base);
    const cookiePath = new URL(init.cookiesOf ?? path, base).pathname;
    const cookie = [...this.jar]
      .filter(([, c]) => cookiePath.startsWith(c.path))
      .map(([name, c]) => `${name}=${c.value}`)
      .join("; ");
    const headers: Record<string, string> = { origin: init.origin ?? new URL(base).origin };
    if (cookie) headers.cookie = cookie;
    if (init.json !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(url, {
      method: init.method ?? (init.json === undefined ? "GET" : "POST"),
      headers,
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
      redirect: "manual",
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";").map((p) => p.trim());
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq);
      const value = pair!.slice(eq + 1);
      const attr = (key: string) => attrs.find((a) => a.toLowerCase().startsWith(`${key}=`))?.split("=")[1];
      const expired = attr("max-age") === "0" || /expires=thu, 01 jan 1970/i.test(line) || value === "";
      if (expired) this.jar.delete(name);
      else this.jar.set(name, { value, path: attr("path") ?? "/" });
    }
    return res;
  }
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function authorizeUrl(params: Record<string, string | undefined>): string {
  const url = new URL("/oauth/authorize", base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.pathname + url.search;
}

function location(res: Response): URL {
  expect(res.status, `expected a redirect, got ${res.status}`).toBe(303);
  return new URL(res.headers.get("location")!, base);
}

async function tokenRequest(form: Record<string, string>): Promise<Response> {
  return fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
}

interface Authorized {
  code: string;
  verifier: string;
  uid: string;
}

/** Start an authorization as the client would and reach the consent screen. */
async function startAuthorization(
  agent: UserAgent,
  overrides: Record<string, string | undefined> = {},
): Promise<{ uid: string; verifier: string }> {
  const { verifier, challenge } = pkce();
  const res = await agent.request(
    authorizeUrl({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "presence:read location:precise",
      state: "s1",
      resource,
      ...overrides,
    }),
  );
  const interaction = location(res);
  const uid = /^\/oauth\/interaction\/([^/]+)$/.exec(interaction.pathname)?.[1];
  expect(uid, interaction.href).toBeTruthy();
  return { uid: uid!, verifier };
}

/** Consent on the dashboard and follow the browser back to the client with a code. */
async function consent(agent: UserAgent, precise = false, overrides: Record<string, string | undefined> = {}): Promise<Authorized> {
  const { uid, verifier } = await startAuthorization(agent, overrides);
  const confirm = await agent.request(`/oauth/interaction/${uid}/confirm`, { json: { precise } });
  expect(confirm.status).toBe(200);
  const { redirectTo } = (await confirm.json()) as { redirectTo: string };
  const back = location(await agent.request(redirectTo));
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get("state")).toBe("s1");
  expect(back.searchParams.get("iss")).toBe(base);
  return { code: back.searchParams.get("code")!, verifier, uid };
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  scope: string;
}

async function exchange({ code, verifier }: Authorized, extra: Record<string, string> = {}): Promise<Response> {
  return tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: CLIENT_ID,
    code_verifier: verifier,
    resource,
    ...extra,
  });
}

async function connect(agent: UserAgent, precise = false): Promise<Tokens> {
  const res = await exchange(await consent(agent, precise));
  expect(res.status).toBe(200);
  return (await res.json()) as Tokens;
}

async function mcp(token: string | undefined, method: string, params: unknown = {}): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
}

async function callTool(token: string, name: string, args: Record<string, unknown> = {}): Promise<{ data: any; isError: boolean }> {
  const res = await mcp(token, "tools/call", { name, arguments: args });
  expect(res.status).toBe(200);
  const { result } = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { data: JSON.parse(result.content[0]!.text), isError: result.isError ?? false };
}

function reading(lat: number, lon: number): NormalizedReading {
  return { precise: { lat, lon, accuracyM: 15 }, motion: "stationary", source: "owntracks", updatedAt: new Date().toISOString() };
}

async function placeAndPresence(userId: string, type: "home" | "work", lat: number, lon: number): Promise<void> {
  const scope = ctx.forUser(asUserId(userId));
  await scope.places.upsert({ name: type, lat, lon, radiusM: 150, type });
  await scope.presence.processReading(reading(lat, lon));
}

describe("discovery", () => {
  it("serves protected resource metadata for /mcp at the path-suffixed and root locations", async () => {
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const res = await fetch(`${base}${path}`, { headers: { origin: "https://client.example" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(await res.json()).toEqual({
        resource,
        authorization_servers: [base],
        scopes_supported: ["presence:read", "location:precise"],
        bearer_methods_supported: ["header"],
        resource_name: "WhereCtx",
      });
    }
  });

  it("serves authorization server metadata at both well-known paths", async () => {
    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      const meta = (await res.json()) as Record<string, unknown>;
      expect(meta).toMatchObject({
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        revocation_endpoint: `${base}/oauth/revoke`,
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: true,
        response_types_supported: ["code"],
      });
      expect(meta.scopes_supported).toEqual(expect.arrayContaining(["presence:read", "location:precise"]));
      expect(meta.grant_types_supported).toEqual(expect.arrayContaining(["authorization_code", "refresh_token"]));
    }
  });

  it("points an unauthenticated /mcp request at the resource metadata", async () => {
    const res = await mcp(undefined, "tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer scope="presence:read location:precise", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("marks a presented but unknown token invalid", async () => {
    const res = await mcp("not-a-real-token", "tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer error="invalid_token", scope="presence:read location:precise", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("answers a token without presence:read with insufficient_scope", async () => {
    const res = await exchange(await consent(new UserAgent(owner.browser.cookie), true, { scope: "location:precise" }));
    const { access_token } = (await res.json()) as Tokens;
    const refused = await mcp(access_token, "tools/list");
    expect(refused.status).toBe(403);
    expect(refused.headers.get("www-authenticate")).toBe(
      `Bearer error="insufficient_scope", scope="presence:read", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
    );
  });
});

describe("authorization code flow with a Client ID Metadata Document client", () => {
  it("sends the browser to the dashboard's consent screen", async () => {
    const agent = new UserAgent(owner.browser.cookie);
    const { uid } = await startAuthorization(agent);
    const res = await agent.request(`/oauth/interaction/${uid}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/dashboard/#authorize/${uid}`);
  });

  it("describes the request to the signed-in person, warning that the redirect is local", async () => {
    const agent = new UserAgent(owner.browser.cookie);
    const { uid } = await startAuthorization(agent);
    const res = await agent.request(`/oauth/interaction/${uid}/details`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      client: { id: CLIENT_ID, name: "Test Agent", uri: "https://client.example" },
      redirectUri: REDIRECT,
      redirectHost: "127.0.0.1:9876",
      localhostOnly: true,
      requestedScopes: ["presence:read", "location:precise"],
      resource,
    });
  });

  it("asks a signed-out browser to sign in, and refuses a cross-origin consent", async () => {
    const anonymous = new UserAgent();
    const { uid } = await startAuthorization(anonymous);
    expect((await anonymous.request(`/oauth/interaction/${uid}/details`)).status).toBe(401);

    const agent = new UserAgent(owner.browser.cookie);
    const started = await startAuthorization(agent);
    const forged = await agent.request(`/oauth/interaction/${started.uid}/confirm`, {
      json: { precise: true },
      origin: "https://evil.example",
    });
    expect(forged.status).toBe(403);
  });

  it("refuses an interaction this browser did not start", async () => {
    const agent = new UserAgent(owner.browser.cookie);
    const { uid } = await startAuthorization(agent);
    const other = new UserAgent(owner.browser.cookie);
    await startAuthorization(other);
    expect((await other.request(`/oauth/interaction/${uid}/confirm`, { json: { precise: false } })).status).toBe(404);
  });

  it("acts only on the interaction the path names, not whichever one the cookie holds", async () => {
    const agent = new UserAgent(owner.browser.cookie);
    const mine = await startAuthorization(agent);
    const theirs = await startAuthorization(new UserAgent(owner.browser.cookie));
    const res = await agent.request(`/oauth/interaction/${theirs.uid}/details`, {
      cookiesOf: `/oauth/interaction/${mine.uid}/details`,
    });
    expect(res.status).toBe(404);
  });

  it("issues an access token that reads the person's presence over /mcp", async () => {
    await placeAndPresence(owner.userId, "home", 37.0, 127.0);
    const tokens = await connect(new UserAgent(owner.browser.cookie));
    expect(tokens.scope).toBe("presence:read");
    expect(tokens.refresh_token).toBeTruthy();
    const { data, isError } = await callTool(tokens.access_token, "get_presence");
    expect(isError).toBe(false);
    expect(data.status).toBe("home");
  });

  it("asks for consent again on every authorization, even from a browser that already consented", async () => {
    const agent = new UserAgent(owner.browser.cookie);
    await consent(agent);
    await startAuthorization(agent);
  });

  it("returns access_denied to the client when the person declines", async () => {
    const agent = new UserAgent(owner.browser.cookie);
    const { uid } = await startAuthorization(agent);
    const abort = await agent.request(`/oauth/interaction/${uid}/abort`, { method: "POST" });
    const { redirectTo } = (await abort.json()) as { redirectTo: string };
    const back = location(await agent.request(redirectTo));
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
  });

  it("refreshes, and the refreshed token still works", async () => {
    await placeAndPresence(owner.userId, "home", 37.0, 127.0);
    const tokens = await connect(new UserAgent(owner.browser.cookie));
    const res = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: CLIENT_ID });
    expect(res.status).toBe(200);
    const refreshed = (await res.json()) as Tokens;
    expect((await callTool(refreshed.access_token, "get_presence")).data.status).toBe("home");
  });
});

describe("resource binding", () => {
  it("refuses an authorization request for another resource", async () => {
    const { challenge } = pkce();
    const res = await new UserAgent(owner.browser.cookie).request(
      authorizeUrl({
        client_id: CLIENT_ID,
        response_type: "code",
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "presence:read",
        resource: "https://evil.example/mcp",
      }),
    );
    expect(location(res).searchParams.get("error")).toBe("invalid_target");
  });

  it("refuses a token request for another resource", async () => {
    const authorized = await consent(new UserAgent(owner.browser.cookie));
    const res = await exchange(authorized, { resource: "https://evil.example/mcp" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_target");
  });

  it("accepts the MCP resource spelled with an upper-case scheme and a trailing slash", async () => {
    const spelled = `${resource.replace("http://", "HTTP://")}/`;
    const authorized = await consent(new UserAgent(owner.browser.cookie), false, { resource: spelled });
    const res = await exchange(authorized, { resource: spelled });
    expect(res.status).toBe(200);
    expect((await mcp(((await res.json()) as Tokens).access_token, "tools/list")).status).toBe(200);
  });

  it("rejects at /mcp an access token whose audience is another resource", async () => {
    const tokens = await connect(new UserAgent(owner.browser.cookie));
    const issued = await ctx.oauth.provider.AccessToken.find(tokens.access_token);
    const client = await ctx.oauth.provider.Client.find(CLIENT_ID);
    const foreign = new ctx.oauth.provider.AccessToken({
      client: client!,
      accountId: owner.userId,
      grantId: issued!.grantId,
      gty: "authorization_code",
      scope: "presence:read",
      aud: "https://evil.example/mcp",
    });
    const value = await foreign.save();
    expect((await mcp(tokens.access_token, "tools/list")).status).toBe(200);
    expect((await mcp(value, "tools/list")).status).toBe(401);
  });

  it("never authenticates the REST API with an OAuth access token", async () => {
    const tokens = await connect(new UserAgent(owner.browser.cookie));
    const res = await fetch(`${base}/v1/places`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect(res.status).toBe(401);
  });
});

describe("PKCE", () => {
  it("refuses an authorization request without a code challenge", async () => {
    const res = await new UserAgent(owner.browser.cookie).request(
      authorizeUrl({ client_id: CLIENT_ID, response_type: "code", redirect_uri: REDIRECT, scope: "presence:read", resource }),
    );
    expect(location(res).searchParams.get("error")).toBe("invalid_request");
  });

  it("refuses a code exchange with the wrong verifier", async () => {
    const authorized = await consent(new UserAgent(owner.browser.cookie));
    const res = await exchange({ ...authorized, verifier: pkce().verifier });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_grant");
  });
});

describe("revocation from the Agents screen", () => {
  it("lists the connected app, and disconnecting it ends its access and refresh tokens", async () => {
    const tokens = await connect(new UserAgent(owner.browser.cookie));
    expect((await mcp(tokens.access_token, "tools/list")).status).toBe(200);

    const { grants } = await owner.browser.json("/v1/oauth/grants");
    expect(grants).toEqual([
      expect.objectContaining({ clientId: CLIENT_ID, clientName: "Test Agent", scopes: ["presence:read"] }),
    ]);

    expect((await owner.browser.send(`/v1/oauth/grants/${grants[0].id}`, { method: "DELETE" })).status).toBe(200);
    expect((await owner.browser.json("/v1/oauth/grants")).grants).toEqual([]);

    expect((await mcp(tokens.access_token, "tools/list")).status).toBe(401);
    const refresh = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: CLIENT_ID });
    expect(refresh.status).toBe(400);
    expect(((await refresh.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("does not let one person see or disconnect another's app", async () => {
    await connect(new UserAgent(owner.browser.cookie));
    const { grants } = await owner.browser.json("/v1/oauth/grants");
    const ws = (await owner.browser.json("/v1/workspaces")).workspaces[0].id;
    const { url } = await owner.browser.json(`/v1/workspaces/${ws}/invites`, { body: { role: "member" } });
    const mina = await signUpByInvite(app, url, "Mina", base);
    expect((await mina.browser.json("/v1/oauth/grants")).grants).toEqual([]);
    expect((await mina.browser.send(`/v1/oauth/grants/${grants[0].id}`, { method: "DELETE" })).status).toBe(404);
    expect((await owner.browser.json("/v1/oauth/grants")).grants).toHaveLength(1);
  });

  it("ends access once the grant has expired", async () => {
    const tokens = await connect(new UserAgent(owner.browser.cookie));
    await ctx.handle.client.execute("UPDATE oauth_store SET expires_at = 1 WHERE model = 'Grant'");
    expect((await mcp(tokens.access_token, "tools/list")).status).toBe(401);
  });

  it("ends access once the grant's person no longer exists", async () => {
    const tokens = await connect(new UserAgent(owner.browser.cookie));
    await ctx.handle.client.execute({ sql: "DELETE FROM users WHERE id = ?", args: [owner.userId] });
    expect((await mcp(tokens.access_token, "tools/list")).status).toBe(401);
  });
});

describe("isolation", () => {
  it("lets each person's token read only that person's presence", async () => {
    const ws = (await owner.browser.json("/v1/workspaces")).workspaces[0].id;
    const { url } = await owner.browser.json(`/v1/workspaces/${ws}/invites`, { body: { role: "member" } });
    const signup = await signUpByInvite(app, url, "Mina", base);
    const minaId = ((await signup.res.json()) as { userId: string }).userId;

    await placeAndPresence(owner.userId, "home", 37.0, 127.0);
    await placeAndPresence(minaId, "work", 35.1, 129.0);

    const ownerTokens = await connect(new UserAgent(owner.browser.cookie));
    const minaTokens = await connect(new UserAgent(signup.browser.cookie));

    expect((await callTool(ownerTokens.access_token, "get_presence")).data.status).toBe("home");
    expect((await callTool(minaTokens.access_token, "get_presence")).data.status).toBe("work");
    expect((await callTool(minaTokens.access_token, "list_places")).data.places.map((p: { name: string }) => p.name)).toEqual([
      "work",
    ]);
  });
});

describe("existing bearer tokens", () => {
  it("keeps accepting a bootstrap agent token without the wctx_ prefix on /mcp", async () => {
    const res = await mcp(BOOTSTRAP_AGENT, "tools/list");
    expect(res.status).toBe(200);
  });

  it("keeps accepting a minted agent token on /mcp and REST", async () => {
    const res = await fetch(`${base}/v1/tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${OWNER_ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "agent", role: "agent" }),
    });
    const { secret } = (await res.json()) as { secret: string };
    expect(secret.startsWith("wctx_")).toBe(true);
    expect((await mcp(secret, "tools/list")).status).toBe(200);
    expect((await fetch(`${base}/v1/places`, { headers: { authorization: `Bearer ${secret}` } })).status).toBe(200);
  });
});

describe("precise location scope", () => {
  beforeEach(async () => {
    await placeAndPresence(owner.userId, "work", 37.5, 127.1);
    const res = await fetch(`${base}/v1/privacy`, {
      method: "PUT",
      headers: { authorization: `Bearer ${OWNER_ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify({ allowPreciseLocation: true }),
    });
    expect(res.status).toBe(200);
  });

  it("is refused to a token whose person left the box unticked", async () => {
    const tokens = await connect(new UserAgent(owner.browser.cookie), false);
    const { data, isError } = await callTool(tokens.access_token, "get_precise_location", { reason: "directions" });
    expect(isError).toBe(true);
    expect(data.error).toMatch(/read_precise_location/);
  });

  it("is granted when the person ticks the box", async () => {
    const tokens = await connect(new UserAgent(owner.browser.cookie), true);
    expect(tokens.scope).toBe("presence:read location:precise");
    const { data, isError } = await callTool(tokens.access_token, "get_precise_location", { reason: "directions" });
    expect(isError).toBe(false);
    expect(data.lat).toBe(37.5);
  });
});

describe("dynamic client registration", () => {
  it("is off by default", async () => {
    const meta = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(meta.registration_endpoint).toBeUndefined();
    const res = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
    });
    expect(res.status).toBe(404);
  });

  it("registers a client when OAUTH_DYNAMIC_REGISTRATION is on", async () => {
    await shutdown();
    await boot({ oauth: { dynamicRegistration: true } });
    const meta = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(meta.registration_endpoint).toBe(`${base}/oauth/register`);
    const res = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", client_name: "Registered" }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { client_id: string }).client_id).toBeTruthy();
  });
});
