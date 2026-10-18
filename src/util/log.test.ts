import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RING_SIZE, clearLogs, formatEntry, log, recentLogs, redactFields, redactString } from "./log.js";

let written: string[];

beforeEach(() => {
  clearLogs();
  written = [];
  const capture = (chunk: unknown) => {
    written.push(String(chunk));
    return true;
  };
  vi.spyOn(process.stdout, "write").mockImplementation(capture as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(capture as typeof process.stderr.write);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const SECRET = "wctx_" + "A".repeat(43);

describe("redaction", () => {
  it.each([
    ["a bearer header", `Authorization: Bearer ${SECRET}`, SECRET],
    ["a bare bearer", "sent Bearer abc.def-123", "abc.def-123"],
    ["a basic credential", "Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    ["a wctx token", `token ${SECRET} rejected`, SECRET],
    ["a short wctx token", "wctx_shortish", "shortish"],
    ["a session cookie", "cookie wctx_session=abcdef0123", "abcdef0123"],
    ["a cookie header", "cookie: __Host-wctx_session=s3cr3t; Path=/", "s3cr3t"],
    ["a token in a query", "GET /v1/ingest/owntracks?token=supersecret&x=1", "supersecret"],
    ["a coordinate pair", "at 37.56651, 126.97800 now", "37.56651"],
    ["a coordinate pair with a space", "at 37.56651 126.97800", "126.97800"],
    ["a long opaque run", "session " + "x".repeat(48), "x".repeat(48)],
  ])("masks %s in a string", (_name, input, leaked) => {
    expect(redactString(input)).not.toContain(leaked);
  });

  it("keeps ordinary text and 32-hex row ids readable", () => {
    const id = "0123456789abcdef0123456789abcdef";
    expect(redactString(`webhook ${id} status 500 after 3 attempts`)).toBe(
      `webhook ${id} status 500 after 3 attempts`,
    );
  });

  it.each([
    "lat",
    "lon",
    "latitude",
    "longitude",
    "precise",
    "password",
    "secret",
    "token",
    "adminToken",
    "authorization",
    "cookie",
    "sessionId",
    "recoveryCodes",
    "setupCode",
    "accessCode",
    "signature",
  ])("masks the value under key %s, nested too", (key) => {
    const out = redactFields({ [key]: "leak-me", nested: { [key]: 12.5 } }) as any;
    expect(out[key]).toBe("[redacted]");
    expect(out.nested[key]).toBe("[redacted]");
    expect(JSON.stringify(out)).not.toContain("leak-me");
  });

  it("redacts an error's message and stack", () => {
    const out = redactFields({ err: new Error(`fetch failed for Bearer ${SECRET}`) });
    expect(String(out.err)).toContain("fetch failed");
    expect(String(out.err)).not.toContain(SECRET);
  });
});

describe("log", () => {
  it("writes a human-readable line and keeps the redacted entry", () => {
    log.warn(`ingest from 37.12345,127.12345 with ${SECRET}`, { token: SECRET, status: 400, path: "/v1/ingest" });
    const line = written.join("");
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\S+ WARN ingest from \[coords\] with wctx_\[redacted\] token=\[redacted\] status=400 path=\/v1\/ingest\n$/);
    expect(line).not.toContain(SECRET);
    const [entry] = recentLogs();
    expect(entry).toMatchObject({ level: "warn", fields: { token: "[redacted]", status: 400 } });
    expect(JSON.stringify(entry)).not.toContain(SECRET);
    expect(JSON.stringify(entry)).not.toContain("127.12345");
  });

  it("never keeps a banner, which carries a secret on purpose", () => {
    log.banner(`Save it now: ${SECRET}`);
    expect(written.join("")).toContain(SECRET);
    expect(recentLogs()).toEqual([]);
  });

  it("returns newest first, filters by level, and keeps only the last RING_SIZE", () => {
    for (let i = 0; i < RING_SIZE + 5; i++) log.info(`n${i}`);
    log.error("boom");
    const all = recentLogs({ limit: RING_SIZE });
    expect(all).toHaveLength(RING_SIZE);
    expect(all[0]!.msg).toBe("boom");
    expect(all.at(-1)!.msg).toBe("n6");
    expect(recentLogs({ minLevel: "warn" }).map((e) => e.msg)).toEqual(["boom"]);
  });

  it("formats an entry without fields", () => {
    expect(formatEntry({ level: "info", time: "T", msg: "hello" })).toBe("T INFO hello");
  });
});

describe("source", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });

  it("writes to the console only through the redacting log", () => {
    const src = new URL("..", import.meta.url).pathname;
    const offenders = files(src).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith("util/log.ts") && /\bconsole\.\w+\(/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
