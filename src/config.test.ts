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
