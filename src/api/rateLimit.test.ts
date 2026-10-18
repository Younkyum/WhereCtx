import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { IncomingMessage } from "node:http";
import { RateLimiter, clientKey, nodeClientKey } from "./rateLimit.js";
import type { TrustProxy } from "../config.js";

describe("RateLimiter", () => {
  it("blocks a key after max hits within the window", () => {
    let nowMs = 0;
    const limiter = new RateLimiter({ windowMs: 60_000, max: 3, clock: () => new Date(nowMs) });
    expect(limiter.isBlocked("1.2.3.4")).toBe(false);
    limiter.record("1.2.3.4");
    limiter.record("1.2.3.4");
    expect(limiter.isBlocked("1.2.3.4")).toBe(false);
    limiter.record("1.2.3.4");
    expect(limiter.isBlocked("1.2.3.4")).toBe(true);
    expect(limiter.isBlocked("5.6.7.8")).toBe(false);
    nowMs += 60_001;
    expect(limiter.isBlocked("1.2.3.4")).toBe(false);
  });

  it("keeps counting new keys in a shared overflow bucket once the table is full", () => {
    const limiter = new RateLimiter({ windowMs: 60_000, max: 3, maxEntries: 2, clock: () => new Date(0) });
    limiter.record("a");
    limiter.record("b");
    for (const key of ["c", "d", "e"]) {
      expect(limiter.isBlocked(key)).toBe(false);
      limiter.record(key);
    }
    expect(limiter.isBlocked("f")).toBe(true);
    expect(limiter.isBlocked("a")).toBe(false);
    limiter.record("a");
    limiter.record("a");
    expect(limiter.isBlocked("a")).toBe(true);
  });
});

describe("client identity", () => {
  const headers = { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.9, 10.0.0.1" };

  function nodeReq(): IncomingMessage {
    return { headers, socket: { remoteAddress: "10.0.0.2" } } as unknown as IncomingMessage;
  }

  async function honoKey(trust: TrustProxy): Promise<string> {
    const app = new Hono();
    app.get("/", (c) => c.text(clientKey(c, trust)));
    const res = await app.request("/", { headers }, { incoming: nodeReq() });
    return res.text();
  }

  it.each([
    ["none", "10.0.0.2"],
    ["cloudflare", "203.0.113.7"],
    ["xff", "198.51.100.9"],
  ] as const)("TRUST_PROXY=%s uses %s", async (trust, expected) => {
    expect(nodeClientKey(nodeReq(), trust)).toBe(expected);
    expect(await honoKey(trust)).toBe(expected);
  });
});
