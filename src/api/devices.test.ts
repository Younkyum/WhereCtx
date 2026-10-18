import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { AppContext } from "../app/context.js";
import { asUserId } from "../types.js";
import { OWNER_ADMIN, TestClock, bootApp, setupOwner, type Enrolled } from "../testing/accounts.js";

let ctx: AppContext;
let app: Hono;
let owner: Enrolled;

beforeEach(async () => {
  const booted = await bootApp(new TestClock());
  ({ ctx, app } = booted);
  owner = await setupOwner(app, booted.setupCode);
});

afterEach(() => ctx.handle.client.close());

const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

async function owntracksPost(authorization: string, path = "/v1/ingest/owntracks"): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ _type: "location", lat: 37.5, lon: 127.0, tst: 1_790_000_000 }),
  });
}

function decodeLink(link: string): unknown {
  const prefix = "owntracks:///config?inline=";
  expect(link.startsWith(prefix)).toBe(true);
  const encoded = decodeURIComponent(link.slice(prefix.length));
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

describe("POST /v1/devices/pair (owntracks)", () => {
  it("returns an HTTP-mode remote config, its import link and a QR code", async () => {
    const res = await owner.browser.send("/v1/devices/pair", { body: { name: "Mina's Pixel", kind: "owntracks" } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;

    expect(body.token).toMatchObject({ name: "Mina's Pixel", role: "device", scopes: ["write_location"] });
    expect(body.config).toEqual({
      _type: "configuration",
      mode: 3,
      url: "http://localhost:8787/v1/ingest/owntracks",
      auth: true,
      username: "mina-s-pixel",
      password: expect.stringMatching(/^wctx_/),
      deviceId: "mina-s-pixel",
      tid: "MI",
      monitoring: 1,
      locatorDisplacement: 500,
      locatorInterval: 300,
    });
    expect(body.config.url).not.toContain("token");
    expect(decodeLink(body.link)).toEqual(body.config);
    expect(body.qrSvg).toMatch(/^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(body.qrSvg).not.toContain("data:");
  });

  it("issues a device token that ingests over Basic auth and cannot read", async () => {
    const body = await owner.browser.json("/v1/devices/pair", { body: { name: "phone", kind: "owntracks" } });
    const auth = basic(body.config.username, body.config.password);

    const ingest = await owntracksPost(auth);
    expect(ingest.status).toBe(200);
    expect(await ingest.json()).toEqual([]);
    expect((await ctx.forUser(asUserId(owner.userId)).presence.getCurrent())?.source).toBe("owntracks");

    const read = await app.request("/v1/presence", { headers: { authorization: `Bearer ${body.config.password}` } });
    expect(read.status).toBe(403);
  });

  it("shows the secret only once", async () => {
    const body = await owner.browser.json("/v1/devices/pair", { body: { name: "phone", kind: "owntracks" } });
    const { tokens } = await owner.browser.json("/v1/tokens");
    expect(JSON.stringify(tokens)).not.toContain(body.config.password);
  });

  it("counts toward the per-user token cap", async () => {
    for (let i = (await ctx.forUser(asUserId(owner.userId)).tokens.count()); i < 50; i++) {
      await owner.browser.json("/v1/devices/pair", { body: { name: `p${i}`, kind: "shortcut" } });
    }
    const res = await owner.browser.send("/v1/devices/pair", { body: { name: "one more", kind: "owntracks" } });
    expect(res.status).toBe(409);
  });

  it("requires manage_tokens", async () => {
    const agent = await owner.browser.json("/v1/tokens", { body: { name: "agent", role: "agent" } });
    const res = await app.request("/v1/devices/pair", {
      method: "POST",
      headers: { authorization: `Bearer ${agent.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "phone", kind: "owntracks" }),
    });
    expect(res.status).toBe(403);
  });

  it("pairs with an admin token too", async () => {
    const res = await app.request("/v1/devices/pair", {
      method: "POST",
      headers: { authorization: `Bearer ${OWNER_ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "phone", kind: "owntracks" }),
    });
    expect(res.status).toBe(201);
  });

  it("rejects an unknown kind", async () => {
    const res = await owner.browser.send("/v1/devices/pair", { body: { name: "phone", kind: "mqtt" } });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/devices/pair (shortcut)", () => {
  it("returns the shortcut URL, token and headers", async () => {
    const body = await owner.browser.json("/v1/devices/pair", { body: { name: "iPhone", kind: "shortcut" } });
    expect(body).toMatchObject({
      kind: "shortcut",
      url: "http://localhost:8787/v1/ingest/shortcut",
      method: "POST",
      token: expect.stringMatching(/^wctx_/),
      headers: { "Content-Type": "application/json" },
    });
    expect(body.headers.Authorization).toBe(`Bearer ${body.token}`);

    const ingest = await app.request(body.url.replace("http://localhost:8787", ""), {
      method: "POST",
      headers: body.headers,
      body: JSON.stringify({ Latitude: 37.5, Longitude: 127.0 }),
    });
    expect(ingest.status).toBe(200);
  });
});

describe("Basic auth", () => {
  it("is accepted on ingest only", async () => {
    const { secret } = await owner.browser.json("/v1/tokens", { body: { name: "agent", role: "agent" } });
    expect((await app.request("/v1/presence", { headers: { authorization: basic("x", secret) } })).status).toBe(401);
    expect((await app.request("/v1/tokens", { headers: { authorization: basic("x", OWNER_ADMIN) } })).status).toBe(401);
  });

  it("rejects a wrong or missing password", async () => {
    expect((await owntracksPost(basic("phone", "wctx_not-a-token"))).status).toBe(401);
    expect((await owntracksPost(`Basic ${Buffer.from("phone").toString("base64")}`)).status).toBe(401);
    expect((await owntracksPost(basic("phone", ""))).status).toBe(401);
  });
});

describe("agent tokens", () => {
  it("come with a ready MCP client config", async () => {
    const body = await owner.browser.json("/v1/tokens", { body: { name: "claude", role: "agent" } });
    expect(body.mcpConfig).toEqual({
      mcpServers: {
        wherectx: {
          url: "http://localhost:8787/mcp",
          headers: { Authorization: `Bearer ${body.secret}` },
        },
      },
    });
  });

  it("other roles get no MCP config", async () => {
    const body = await owner.browser.json("/v1/tokens", { body: { name: "phone", role: "device" } });
    expect(body.mcpConfig).toBeUndefined();
  });
});

describe("web one-shot share", () => {
  it("lets a signed-in person post a manual reading", async () => {
    const res = await owner.browser.send("/v1/ingest", {
      body: { source: "manual", lat: 37.5, lon: 127.0 },
    });
    expect(res.status).toBe(200);
    const current = await ctx.forUser(asUserId(owner.userId)).presence.getCurrent();
    expect(current).toMatchObject({ source: "manual", precise: { lat: 37.5, lon: 127.0 } });
  });

  it("refuses a cross-origin one-shot share", async () => {
    const res = await owner.browser.send("/v1/ingest", {
      body: { source: "manual", lat: 37.5, lon: 127.0 },
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
  });
});
