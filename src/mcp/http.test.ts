import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import type { WhereCtxConfig } from "../config.js";
import { asUserId } from "../types.js";
import { createAppContext, type AppContext } from "../app/context.js";
import { mcpNodeHandler } from "./http.js";

const ADMIN = "admin-token-strong-0123456789abcdef";
const DEVICE = "device-token-strong-0123456789abcdef";
const AGENT = "agent-token-strong-0123456789abcdef";

const config: WhereCtxConfig = {
  port: 0,
  host: "127.0.0.1",
  baseUrl: "http://localhost:8787",
  databaseUrl: ":memory:",
  defaultUserId: asUserId("default"),
  bootstrapTokens: { admin: ADMIN, device: DEVICE, agent: AGENT },
  privacy: {
    defaultAgentAccess: "coarse",
    preciseRequiresReason: true,
    allowPreciseToAgent: false,
    hideHomeExactCoordinates: true,
    protectHomePlace: true,
    staleAfterSec: 900,
    retentionHours: 24,
    storeRawHistory: false,
  },
  geofence: { nearRadiusMultiplier: 3 },
  webhooks: { allowPrivateTargets: false },
  events: { retentionHours: 720 },
};

let ctx: AppContext;
let server: Server;
let base: string;

beforeEach(async () => {
  ctx = (await createAppContext(config)).ctx;
  const handler = mcpNodeHandler(ctx);
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}/mcp`;
});

afterEach(() => {
  server.close();
  ctx.handle.client.close();
});

const initBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
});

async function post(token?: string, body = initBody): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (token) headers["authorization"] = `Bearer ${token}`;
  return fetch(base, { method: "POST", headers, body });
}

describe("MCP /mcp auth boundary", () => {
  it("rejects requests with no token (401)", async () => {
    expect((await post(undefined)).status).toBe(401);
  });

  it("rejects a non-Bearer Authorization header (401)", async () => {
    const r = await fetch(base, {
      method: "POST",
      headers: { authorization: AGENT, "content-type": "application/json" },
      body: initBody,
    });
    expect(r.status).toBe(401);
  });

  it("rejects a device token — agents-only read boundary (403)", async () => {
    expect((await post(DEVICE)).status).toBe(403);
  });

  it("accepts an agent token (not 401/403)", async () => {
    const r = await post(AGENT);
    expect(r.status).not.toBe(401);
    expect(r.status).not.toBe(403);
  });

  it("rejects an oversized body (413)", async () => {
    const big = JSON.stringify({ x: "y".repeat(70 * 1024) });
    expect((await post(AGENT, big)).status).toBe(413);
  });

  it("rejects malformed JSON (400)", async () => {
    expect((await post(AGENT, "{not json")).status).toBe(400);
  });
});
