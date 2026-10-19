import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
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

describe("map tiles (MAP_TILE_URL, MAP_TILE_ATTRIBUTION, MAP_TILE_ATTRIBUTION_URL)", () => {
  const VARS = ["MAP_TILE_URL", "MAP_TILE_ATTRIBUTION", "MAP_TILE_ATTRIBUTION_URL"] as const;
  afterEach(() => {
    for (const v of VARS) delete process.env[v];
  });
  const load = (env: Partial<Record<(typeof VARS)[number], string>>) => {
    for (const v of VARS) delete process.env[v];
    Object.assign(process.env, env);
    return loadConfig().mapTiles;
  };

  it("defaults to OpenStreetMap's tiles, credited and linked", () => {
    expect(load({})).toEqual({
      url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      origin: "https://tile.openstreetmap.org",
      attribution: "© OpenStreetMap contributors",
      attributionUrl: "https://www.openstreetmap.org/copyright",
    });
  });

  it("takes a self-hosted template, its one origin, and plain-text credit without a link", () => {
    expect(load({ MAP_TILE_URL: "https://tiles.example.org:8443/osm/{z}/{x}/{y}{r}.png?v=2", MAP_TILE_ATTRIBUTION: "© OSM, tiles by us", MAP_TILE_ATTRIBUTION_URL: "off" })).toEqual({
      url: "https://tiles.example.org:8443/osm/{z}/{x}/{y}{r}.png?v=2",
      origin: "https://tiles.example.org:8443",
      attribution: "© OSM, tiles by us",
      attributionUrl: null,
    });
  });

  it("is null when maps are off", () => {
    expect(load({ MAP_TILE_URL: "off" })).toBeNull();
  });

  it.each([
    ["http://tile.openstreetmap.org/{z}/{x}/{y}.png", /https/],
    ["https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", /only \{z\}, \{x\}, \{y\} and \{r\}/],
    ["https://{z}.tiles.example.org/{x}/{y}.png", /one host/],
    ["https://tiles.example.org/{z}/{x}.png", /\{z\}, \{x\} and \{y\}/],
    ["https://user:pw@tiles.example.org/{z}/{x}/{y}.png", /without credentials/],
    ["not a url {z}{x}{y}", /https URL/],
  ])("refuses MAP_TILE_URL=%s at boot", (url, why) => {
    expect(() => load({ MAP_TILE_URL: url })).toThrow(why);
  });

  it("refuses an empty or unprintable attribution, and a link that is not https", () => {
    expect(() => load({ MAP_TILE_ATTRIBUTION: "a‮b" })).toThrow(/MAP_TILE_ATTRIBUTION/);
    expect(() => load({ MAP_TILE_ATTRIBUTION: "x".repeat(201) })).toThrow(/MAP_TILE_ATTRIBUTION/);
    expect(() => load({ MAP_TILE_ATTRIBUTION_URL: "javascript:alert(1)" })).toThrow(/MAP_TILE_ATTRIBUTION_URL/);
  });
});
