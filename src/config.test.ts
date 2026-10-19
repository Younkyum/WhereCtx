import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeDatabaseUrl } from "./db/url.js";

describe("normalizeDatabaseUrl", () => {
  it("passes through file: URLs unchanged", () => {
    expect(normalizeDatabaseUrl("file:./data/wherectx.db")).toBe(
      "file:./data/wherectx.db",
    );
  });

  it("normalizes docker-compose sqlite:////absolute form", () => {
    expect(normalizeDatabaseUrl("sqlite:////data/wherectx.db")).toBe(
      "file:/data/wherectx.db",
    );
  });

  it("normalizes sqlite://./relative form", () => {
    expect(normalizeDatabaseUrl("sqlite://./data/wherectx.db")).toBe(
      "file:./data/wherectx.db",
    );
  });

  it("treats a bare path as a file URL", () => {
    expect(normalizeDatabaseUrl("/data/wherectx.db")).toBe(
      "file:/data/wherectx.db",
    );
  });

  it("normalizes sqlite:///relative form (3 slashes)", () => {
    expect(normalizeDatabaseUrl("sqlite:///wherectx.db")).toBe("file:wherectx.db");
  });

  it("passes through remote libsql/turso URLs", () => {
    expect(normalizeDatabaseUrl("libsql://db.turso.io")).toBe(
      "libsql://db.turso.io",
    );
    expect(normalizeDatabaseUrl("https://db.example.com")).toBe(
      "https://db.example.com",
    );
    expect(normalizeDatabaseUrl("wss://db.example.com")).toBe(
      "wss://db.example.com",
    );
  });

  it("short-circuits in-memory forms to :memory:", () => {
    expect(normalizeDatabaseUrl(":memory:")).toBe(":memory:");
    expect(normalizeDatabaseUrl("file::memory:")).toBe(":memory:");
    expect(normalizeDatabaseUrl("sqlite::memory:")).toBe(":memory:");
  });
});

describe("env documentation", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const configVars = new Set(
    [...read("./config.ts").matchAll(/env\w+\("([A-Z0-9_]+)"/g)].map((m) => m[1]!),
  );
  const keys = (text: string, pattern: RegExp) =>
    new Set([...text.matchAll(pattern)].map((m) => m[1]!));
  const documented = (text: string) => keys(text, /^#?([A-Z0-9_]+)=/gm);
  const active = (text: string) => keys(text, /^([A-Z0-9_]+)=/gm);

  it("finds the variables config.ts reads", () => {
    expect(configVars).toContain("BASE_URL");
    expect(configVars).toContain("SHARE_AUDIT_RETENTION_DAYS");
  });

  it.each([
    ["../.env.example", []],
    ["../deploy/.env.nas.example", ["CF_TUNNEL_TOKEN"]],
  ])("%s documents every variable config.ts reads, and nothing else", (path, extra) => {
    const text = read(path);
    expect([...configVars].filter((v) => !documented(text).has(v))).toEqual([]);
    expect([...active(text)].filter((v) => !configVars.has(v) && !extra.includes(v))).toEqual([]);
  });

  it("the NAS compose file passes every variable config.ts reads except the fixed listen address and the test-only fake", () => {
    const compose = read("../deploy/docker-compose.nas.yml");
    const passed = keys(compose, /^ {6}([A-Z0-9_]+):/gm);
    const fixed = ["PORT", "HOST"];
    // The fake maps provider is refused in production, so the NAS file never passes it.
    const testOnly = ["GEO_PROVIDER_FAKE"];
    expect([...configVars].filter((v) => !passed.has(v) && !fixed.includes(v) && !testOnly.includes(v))).toEqual([]);
  });
});
