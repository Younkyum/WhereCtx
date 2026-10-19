import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AppContext } from "../app/context.js";
import { resolveTokenPrincipal } from "../auth/principal.js";
import { REST_ACTIONS } from "../api/accessAudit.js";
import { ACCESS_COALESCE_MS } from "./accessLogStore.js";
import { ACCESS_ACTIONS } from "./types.js";
import { log } from "../util/log.js";
import { buildMcpServer } from "../mcp/server.js";
import { MAX_BATCH_MESSAGES, mcpNodeHandler } from "../mcp/http.js";
import { Browser, TestClock, bootApp, setupOwner, signUpByInvite, type Enrolled } from "../testing/accounts.js";

const HOME = { lat: 37.5, lon: 127.0 };
const DAY = 86_400_000;

let clock: TestClock;
let ctx: AppContext;
let app: Hono;
let owner: Enrolled;
let mina: { browser: Browser; userId: string };
let agent: string;

async function mint(browser: Browser, name: string, role = "agent"): Promise<{ id: string; secret: string }> {
  const r = await browser.json("/v1/tokens", { body: { name, role } });
  return { id: r.token.id, secret: r.secret };
}

/** Each call a millisecond after the last, so newest-first order is the call order. */
const asToken = (path: string, secret: string, init: RequestInit = {}) => {
  clock.advance(1);
  return app.request(path, { ...init, headers: { authorization: `Bearer ${secret}`, ...(init.headers ?? {}) } });
};

async function accessOf(browser: Browser, query = ""): Promise<any> {
  return browser.json(`/v1/activity/access${query}`);
}

beforeEach(async () => {
  clock = new TestClock();
  const booted = await bootApp(clock);
  ({ ctx, app } = booted);
  owner = await setupOwner(app, booted.setupCode);
  const ws = (await owner.browser.json("/v1/workspaces")).workspaces[0].id;
  const { url } = await owner.browser.json(`/v1/workspaces/${ws}/invites`, { body: { role: "member" } });
  const joined = await signUpByInvite(app, url, "Mina");
  mina = { browser: joined.browser, userId: ((await joined.res.json()) as any).userId };
  await owner.browser.json("/v1/places", { body: { name: "home", type: "home", ...HOME, radiusM: 100 } });
  await owner.browser.json("/v1/ingest", { body: { source: "manual", lat: HOME.lat + 0.01, lon: HOME.lon } });
  agent = (await mint(owner.browser, "Claude Desktop")).secret;
});

describe("REST access log", () => {
  it("records each agent read with the token's name, surface and outcome", async () => {
    expect((await asToken("/v1/presence", agent)).status).toBe(200);
    expect((await asToken("/v1/places", agent)).status).toBe(200);
    expect((await asToken("/v1/events", agent)).status).toBe(200);
    expect((await asToken("/v1/presence/precise?reason=find%20me", agent)).status).toBe(403);

    const { entries } = await accessOf(owner.browser);
    expect(entries.map((e: any) => [e.action, e.outcome])).toEqual([
      ["presence.precise", "denied"],
      ["events.list", "allowed"],
      ["places.list", "allowed"],
      ["presence.read", "allowed"],
    ]);
    const precise = entries[0];
    expect(precise).toMatchObject({
      credential: { kind: "token", name: "Claude Desktop" },
      surface: "rest",
      precise: true,
      reason: "find me",
    });
    expect(precise.denial).toMatch(/precise location denied/);
  });

  it("redacts a reason or a denial the way the ingest log does", async () => {
    await asToken(`/v1/presence/precise?reason=${encodeURIComponent("meet at 37.56651, 126.97800 with Bearer abc.def-123")}`, agent);
    const [entry] = (await accessOf(owner.browser)).entries;
    expect(entry.reason).toContain("meet at");
    expect(entry.reason).not.toContain("37.56651");
    expect(entry.reason).not.toContain("abc.def-123");
  });

  it("records hidden mode as hidden", async () => {
    await owner.browser.json("/v1/privacy", { method: "PUT", body: { defaultAgentAccess: "hidden" } });
    expect((await asToken("/v1/presence", agent)).status).toBe(403);
    const [entry] = (await accessOf(owner.browser)).entries;
    expect(entry).toMatchObject({ action: "presence.read", outcome: "hidden" });
  });

  it("records a scope refusal as denied", async () => {
    const device = (await mint(owner.browser, "Phone", "device")).secret;
    expect((await asToken("/v1/presence", device)).status).toBe(403);
    const [entry] = (await accessOf(owner.browser)).entries;
    expect(entry).toMatchObject({ action: "presence.read", outcome: "denied", credential: { name: "Phone" } });
    expect(entry.denial).toMatch(/read_presence/);
  });

  it("does not record the owner's own session reads", async () => {
    await owner.browser.json("/v1/presence");
    await owner.browser.json("/v1/places");
    await owner.browser.json("/v1/events");
    await owner.browser.json("/v1/presence/history");
    expect((await accessOf(owner.browser)).entries).toEqual([]);
  });

  it("records every token request on every /v1 route but ingest and auth, each under a named action", async () => {
    const admin = (await mint(owner.browser, "admin", "admin")).secret;
    const routes = app.routes
      .filter((r) => r.method !== "ALL" && r.path.startsWith("/v1/"))
      .filter((r) => !r.path.startsWith("/v1/auth/") && !r.path.startsWith("/v1/ingest"))
      .map((r) => `${r.method} ${r.path}`);
    const unique = [...new Set(routes)];
    expect(unique.length).toBeGreaterThan(40);
    for (const route of unique) {
      const [method, pattern] = route.split(" ") as [string, string];
      clock.advance(ACCESS_COALESCE_MS);
      const res = await asToken(pattern.replace(/:[^/]+/g, "x"), admin, { method });
      expect(res.status, route).toBeLessThan(500);
    }
    const { entries } = await accessOf(owner.browser, "?limit=200");
    expect(entries).toHaveLength(unique.length);
    const actions = entries.map((e: any) => e.action);
    expect(actions.filter((a: string) => a === "unknown")).toEqual([]);
    for (const [route, action] of Object.entries(REST_ACTIONS)) {
      expect(unique, `${route} is no longer mounted`).toContain(route);
      expect(actions).toContain(action);
    }
    const account = unique.filter((r) => /^\S+ \/v1\/(me|workspaces|shares|people|oauth)\b/.test(r));
    expect(actions.filter((a: string) => a === "account")).toHaveLength(account.length);
    expect(unique.filter((r) => !account.includes(r) && !(r in REST_ACTIONS))).toEqual([]);
  });

  it("records a token on the OAuth consent API as account, and nothing else outside /v1", async () => {
    const consent = [
      "GET /oauth/interaction/:uid/details",
      "POST /oauth/interaction/:uid/confirm",
      "POST /oauth/interaction/:uid/abort",
    ];
    const exempt: Record<string, string> = {
      "GET /": "server name and version, no credential",
      "GET /healthz": "liveness probe, no credential",
      "GET /dashboard": "static dashboard files",
      "GET /dashboard/*": "static dashboard files",
      "GET /.well-known/oauth-protected-resource/mcp": "public RFC 9728 metadata",
      "GET /.well-known/oauth-protected-resource": "public RFC 9728 metadata",
      "GET /oauth/interaction/:uid": "a redirect to the consent screen, no credential",
    };
    const outside = [
      ...new Set(app.routes.filter((r) => r.method !== "ALL" && !r.path.startsWith("/v1/")).map((r) => `${r.method} ${r.path}`)),
    ];
    expect(outside.sort()).toEqual([...consent, ...Object.keys(exempt)].sort());
    const admin = (await mint(owner.browser, "admin", "admin")).secret;
    for (const route of outside) {
      const [method, pattern] = route.split(" ") as [string, string];
      clock.advance(ACCESS_COALESCE_MS);
      const res = await asToken(pattern.replace(/:[^/]+/g, "x").replace("*", "index.html"), admin, { method });
      if (consent.includes(route)) expect(res.status, route).toBe(403);
    }
    const { entries } = await accessOf(owner.browser);
    expect(entries.map((e: any) => [e.action, e.outcome])).toEqual(consent.map(() => ["account", "denied"]));
  });

  it("records privacy, webhook and token changes made with a token", async () => {
    const admin = (await mint(owner.browser, "admin", "admin")).secret;
    const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await asToken("/v1/privacy", admin, json("PUT", { storeRawHistory: true }))).status).toBe(200);
    const hook = await (await asToken("/v1/webhooks", admin, json("POST", { url: "https://example.com/h" }))).json();
    expect((await asToken(`/v1/webhooks/${hook.webhook.id}`, admin, json("PATCH", { active: false }))).status).toBe(200);
    expect((await asToken(`/v1/webhooks/${hook.webhook.id}`, admin, { method: "DELETE" })).status).toBe(200);
    expect((await asToken("/v1/tokens", admin)).status).toBe(200);
    const { entries } = await accessOf(owner.browser);
    expect(entries.map((e: any) => [e.action, e.outcome])).toEqual([
      ["tokens.list", "allowed"],
      ["webhooks.delete", "allowed"],
      ["webhooks.update", "allowed"],
      ["webhooks.create", "allowed"],
      ["privacy.update", "allowed"],
    ]);
  });

  it("names a request no route matched unknown and denied, and never stores its path", async () => {
    expect((await asToken("/v1/presence/secret-probe-path", agent)).status).toBe(404);
    clock.advance(ACCESS_COALESCE_MS);
    expect((await asToken("/v1/presence", agent, { method: "POST" })).status).toBe(404);
    const { entries } = await accessOf(owner.browser);
    expect(entries.map((e: any) => [e.action, e.outcome])).toEqual([
      ["unknown", "denied"],
      ["unknown", "denied"],
    ]);
    expect(JSON.stringify(entries)).not.toContain("secret-probe-path");
  });

  it("names a HEAD request as its GET route", async () => {
    expect((await asToken("/v1/presence", agent, { method: "HEAD" })).status).toBe(200);
    const [entry] = (await accessOf(owner.browser)).entries;
    expect(entry).toMatchObject({ action: "presence.read", outcome: "allowed" });
  });

  it("records a precise request refused by hidden mode as hidden", async () => {
    await owner.browser.json("/v1/privacy", { method: "PUT", body: { defaultAgentAccess: "hidden" } });
    const precise = (await mint(owner.browser, "precise bot", "admin")).secret;
    expect((await asToken("/v1/presence/precise?reason=why", precise)).status).toBe(403);
    const [entry] = (await accessOf(owner.browser)).entries;
    expect(entry).toMatchObject({ action: "presence.precise", outcome: "hidden", precise: true, reason: "why" });
  });

  it("records a precise request refused by scope with the reason given", async () => {
    const device = (await mint(owner.browser, "Phone", "device")).secret;
    expect((await asToken("/v1/presence/precise?reason=just%20curious", device)).status).toBe(403);
    const [entry] = (await accessOf(owner.browser)).entries;
    expect(entry).toMatchObject({ action: "presence.precise", outcome: "denied", precise: true, reason: "just curious" });
    expect(entry.denial).toMatch(/read_precise_location/);
  });

  it("marks a place list precise when it carries coordinates", async () => {
    const admin = (await mint(owner.browser, "admin", "admin")).secret;
    await asToken("/v1/places", agent);
    await asToken("/v1/places", admin);
    const { entries } = await accessOf(owner.browser);
    expect(entries.map((e: any) => [e.credential.name, e.precise])).toEqual([
      ["admin", true],
      ["Claude Desktop", false],
    ]);
  });

  it("records a server failure as an error, not a refusal", async () => {
    vi.spyOn(ctx.system.presence, "getCurrent").mockRejectedValueOnce(new Error("db locked"));
    expect((await asToken("/v1/presence", agent)).status).toBe(500);
    const [entry] = (await accessOf(owner.browser)).entries;
    expect(entry).toMatchObject({ action: "presence.read", outcome: "error" });
    expect(entry.denial).toBeUndefined();
  });

  it("serves the request when the log write fails, and reports the failure", async () => {
    const record = vi.spyOn(ctx.system.accessLog, "record").mockRejectedValueOnce(new Error("disk full"));
    const error = vi.spyOn(log, "error");
    expect((await asToken("/v1/presence", agent)).status).toBe(200);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]![1]).toMatchObject({ action: "presence.read", outcome: "allowed" });
    expect(error).toHaveBeenCalledWith("could not record an agent request", expect.any(Error), expect.objectContaining({ action: "presence.read" }));
  });
});

describe("MCP access log", () => {
  const ARGS: Record<string, Record<string, unknown>> = {
    get_presence: {},
    get_precise_location: { reason: "pick me up" },
    is_near_place: { name: "home" },
    list_places: {},
    get_location_age: {},
    list_recent_presence_events: {},
    create_location_reminder: { place: "home", message: "water the plants" },
    create_place: { name: "gym", type: "custom", lat: 37.51, lon: 127.01 },
    remember_current_place: { name: "here" },
    get_eta: { to: "home" },
    get_directions: { to: "home" },
  };

  it("records every tool call through the one registration wrapper", async () => {
    const principal = (await resolveTokenPrincipal(ctx, agent))!;
    const server = buildMcpServer(ctx.forUser(principal.userId), principal, ctx);
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    await client.connect(c);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(ARGS).sort());
    for (const tool of tools) expect(ACCESS_ACTIONS as readonly string[]).toContain(tool.name);
    for (const tool of tools) await client.callTool({ name: tool.name, arguments: ARGS[tool.name]! });

    const { entries } = await accessOf(owner.browser, "?limit=50");
    expect(entries.map((e: any) => e.action).sort()).toEqual(Object.keys(ARGS).sort());
    expect(entries.every((e: any) => e.surface === "mcp" && e.credential.name === "Claude Desktop")).toBe(true);
    const precise = entries.find((e: any) => e.action === "get_precise_location");
    expect(precise).toMatchObject({ precise: true, reason: "pick me up", outcome: "denied" });
    expect(entries.find((e: any) => e.action === "get_presence").outcome).toBe("allowed");
  });

  it("records hidden mode on a tool as hidden", async () => {
    await owner.browser.json("/v1/privacy", { method: "PUT", body: { defaultAgentAccess: "hidden" } });
    const principal = (await resolveTokenPrincipal(ctx, agent))!;
    const server = buildMcpServer(ctx.forUser(principal.userId), principal, ctx);
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    await client.connect(c);
    await client.callTool({ name: "get_presence", arguments: {} });
    const [entry] = (await accessOf(owner.browser)).entries;
    expect(entry).toMatchObject({ action: "get_presence", outcome: "hidden" });
  });
});

describe("MCP requests the SDK or the endpoint refuses", () => {
  async function connected() {
    const principal = (await resolveTokenPrincipal(ctx, agent))!;
    const server = buildMcpServer(ctx.forUser(principal.userId), principal, ctx);
    const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    await client.connect(c);
    return client;
  }

  it("records each call refused by schema validation, once, as invalid arguments", async () => {
    const client = await connected();
    const calls: Array<[string, Record<string, unknown>]> = [
      ["get_precise_location", {}],
      ["get_precise_location", { reason: "" }],
      ["get_precise_location", { reason: "x".repeat(300) }],
      ["create_place", { name: "pole", type: "custom", lat: 91, lon: 0 }],
      ["list_recent_presence_events", { limit: 1000 }],
    ];
    for (const [name, args] of calls) {
      clock.advance(ACCESS_COALESCE_MS + 1);
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, name).toBe(true);
    }
    const { entries } = await accessOf(owner.browser);
    expect(entries.map((e: any) => [e.action, e.outcome, e.denial])).toEqual(
      calls.map(([name]) => [name, "denied", "invalid arguments"]).reverse(),
    );
    expect(JSON.stringify(entries)).not.toContain("xxxxxxxxxx");
  });

  it("records an unknown tool as unknown, without its name", async () => {
    const client = await connected();
    const result = await client.callTool({ name: "exfiltrate_everything", arguments: {} });
    expect(result.isError).toBe(true);
    const { entries } = await accessOf(owner.browser);
    expect(entries.map((e: any) => [e.action, e.outcome, e.denial])).toEqual([["unknown", "denied", "unknown tool"]]);
    expect(JSON.stringify(entries)).not.toContain("exfiltrate");
  });

  describe("over HTTP", () => {
    let url: string;
    let server: Server;
    beforeEach(async () => {
      const handler = mcpNodeHandler(ctx);
      server = createServer((req, res) => void handler(req, res));
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    });
    afterEach(() => {
      server.close();
    });
    const rpc = (token: string, body: unknown) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    const call = (id: number, name: string, args: Record<string, unknown> = {}) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    });

    it("records a token without read_presence that is refused at the door", async () => {
      const device = (await mint(owner.browser, "Phone", "device")).secret;
      expect((await rpc(device, call(1, "get_presence"))).status).toBe(403);
      const { entries } = await accessOf(owner.browser);
      expect(entries).toEqual([
        expect.objectContaining({ action: "mcp.request", outcome: "denied", surface: "mcp", credential: expect.objectContaining({ name: "Phone" }) }),
      ]);
      expect(entries[0].denial).toMatch(/read_presence/);
    });

    it("records each tool call in a batch, and refuses a batch over the cap", async () => {
      const ok = await rpc(agent, [call(1, "get_presence"), call(2, "list_places"), call(3, "nope")]);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toHaveLength(3);
      const big = await rpc(agent, Array.from({ length: MAX_BATCH_MESSAGES + 1 }, (_, i) => call(i + 1, "get_presence")));
      expect(big.status).toBe(400);
      expect((await big.json()).error.message).toMatch(/batch too large/);
      const { entries } = await accessOf(owner.browser);
      expect(entries.map((e: any) => e.action).sort()).toEqual(["get_presence", "list_places", "mcp.request", "unknown"]);
    });
  });
});

describe("GET /v1/activity/access", () => {
  it("shows each person only their own log", async () => {
    await asToken("/v1/presence", agent);
    const minaAgent = (await mint(mina.browser, "Mina's bot")).secret;
    await asToken("/v1/places", minaAgent);
    const mine = (await accessOf(owner.browser)).entries;
    const hers = (await accessOf(mina.browser)).entries;
    expect(mine.map((e: any) => e.credential.name)).toEqual(["Claude Desktop"]);
    expect(hers.map((e: any) => e.credential.name)).toEqual(["Mina's bot"]);
  });

  it("refuses tokens, even the owner's admin token", async () => {
    const admin = (await mint(owner.browser, "admin", "admin")).secret;
    expect((await asToken("/v1/activity/access", admin)).status).toBe(403);
    expect((await asToken("/v1/activity/access", agent)).status).toBe(403);
  });

  it("is not cached", async () => {
    const res = await owner.browser.send("/v1/activity/access");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("pages with the next cursor and filters by credential", async () => {
    const other = await mint(owner.browser, "Other bot");
    for (let i = 0; i < 3; i++) {
      clock.advance(ACCESS_COALESCE_MS);
      await asToken("/v1/presence", agent);
    }
    await asToken("/v1/presence", other.secret);
    const first = await accessOf(owner.browser, "?limit=2");
    expect(first.entries).toHaveLength(2);
    const second = await accessOf(owner.browser, `?limit=2&before=${encodeURIComponent(first.next)}`);
    expect(second.entries).toHaveLength(2);
    expect(second.next).toBeUndefined();
    const ids = [...first.entries, ...second.entries].map((e: any) => e.id);
    expect(new Set(ids).size).toBe(4);
    const filtered = await accessOf(owner.browser, `?credential=${other.id}`);
    expect(filtered.entries.map((e: any) => e.credential.name)).toEqual(["Other bot"]);
  });
});

describe("flood control", () => {
  it("folds identical requests within a minute into one row with a count", async () => {
    for (let i = 0; i < 5; i++) await asToken("/v1/presence", agent);
    const [entry, ...rest] = (await accessOf(owner.browser)).entries;
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ action: "presence.read", outcome: "allowed", count: 5 });
    expect(Date.parse(entry.lastAt) - Date.parse(entry.createdAt)).toBe(4);
  });

  it("keeps the window sliding from the latest request, and starts a new row after a quiet minute", async () => {
    await asToken("/v1/presence", agent);
    clock.advance(ACCESS_COALESCE_MS - 10);
    await asToken("/v1/presence", agent);
    clock.advance(ACCESS_COALESCE_MS - 10);
    await asToken("/v1/presence", agent);
    clock.advance(ACCESS_COALESCE_MS + 1);
    await asToken("/v1/presence", agent);
    expect((await accessOf(owner.browser)).entries.map((e: any) => e.count)).toEqual([1, 3]);
  });

  it("keeps separate rows for a different outcome, denial, action or credential", async () => {
    const other = (await mint(owner.browser, "Other bot")).secret;
    const device = (await mint(owner.browser, "Phone", "device")).secret;
    await asToken("/v1/presence", agent);
    await asToken("/v1/presence", other);
    await asToken("/v1/places", agent);
    await asToken("/v1/presence", device);
    await asToken("/v1/presence/precise?reason=a", device);
    await owner.browser.json("/v1/privacy", { method: "PUT", body: { defaultAgentAccess: "hidden" } });
    await asToken("/v1/presence", agent);
    await asToken("/v1/presence", agent);
    const { entries } = await accessOf(owner.browser);
    expect(entries.map((e: any) => [e.credential.name, e.action, e.outcome, e.count])).toEqual([
      ["Claude Desktop", "presence.read", "hidden", 2],
      ["Phone", "presence.precise", "denied", 1],
      ["Phone", "presence.read", "denied", 1],
      ["Claude Desktop", "places.list", "allowed", 1],
      ["Other bot", "presence.read", "allowed", 1],
      ["Claude Desktop", "presence.read", "allowed", 1],
    ]);
  });
});

describe("retention", () => {
  it("prunes rows older than the retention window", async () => {
    await asToken("/v1/presence", agent);
    clock.advance(10 * DAY);
    await asToken("/v1/places", agent);
    expect(await ctx.system.accessLog.prune(5)).toBe(1);
    expect((await accessOf(owner.browser)).entries.map((e: any) => e.action)).toEqual(["places.list"]);
  });
});
