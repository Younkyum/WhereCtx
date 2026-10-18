import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, ensureSchema } from "../db/index.js";
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
    ["named coordinates", "coordinates out of range (lat=37.5, lon=200)", "37.5"],
    ["named coordinates in JSON", '{"latitude": -33.9}', "33.9"],
    ["a long opaque run", "session " + "x".repeat(48), "x".repeat(48)],
    ["userinfo in a URL", "connect https://admin:hunter2@db.example.com/x failed", "hunter2"],
    ["userinfo without a password", "libsql://alice@db.example.com", "alice"],
    ["a libsql authToken", "libsql://db.example.com?authToken=eyJhbGciOi.abc", "eyJhbGciOi"],
    ["an api_key query parameter", "GET /x?api_key=k3y-value&y=2", "k3y-value"],
    ["an access_token query parameter", "/cb?state=1&access_token=at-123", "at-123"],
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
    "accessToken",
    "authToken",
    "apiKey",
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

  it.each(["sessionCount", "tokensIssued", "statusCode", "preciseRequiresReason", "secretsRotated"])(
    "keeps the value under key %s, which only mentions a sensitive word",
    (key) => {
      expect(redactFields({ [key]: 3 })).toEqual({ [key]: 3 });
    },
  );

  it.each(["Basic auth failed", "Bearer token missing", "Basic authentication is not offered"])(
    "leaves prose about auth readable: %s",
    (text) => {
      expect(redactString(text)).toBe(text);
    },
  );

  it("reads values JSON cannot: bigint, dates, URLs, maps, sets, and getters that throw", () => {
    const tricky = {
      get boom(): string {
        throw new Error("getter");
      },
    };
    const out = redactFields({
      big: 12n,
      at: new Date("2026-01-02T03:04:05.000Z"),
      bad: new Date("nope"),
      url: new URL("https://u:p4ss@example.com/?token=t0ken"),
      map: new Map([["accessToken", "m1"], ["n", 1]]),
      set: new Set(["a"]),
      tricky,
    });
    expect(out).toEqual({
      big: "12",
      at: "2026-01-02T03:04:05.000Z",
      bad: "Invalid Date",
      url: "https://[redacted]@example.com/?token=[redacted]",
      map: { accessToken: "[redacted]", n: 1 },
      set: ["a"],
      tricky: { boom: "[unreadable]" },
    });
  });

  it("redacts an error's message and stack", () => {
    const out = JSON.stringify(redactFields({ err: new Error(`fetch failed for Bearer ${SECRET}`) }));
    expect(out).toContain("fetch failed");
    expect(out).not.toContain(SECRET);
  });
});

describe("errors", () => {
  const LEAKS = ["37.5", "127.25", "wydm9q", "hook-secret-1", "hooks.slack.com", "T0001/B0002"];

  async function failedQuery(): Promise<unknown> {
    const handle = createDb(":memory:");
    await ensureSchema(handle);
    try {
      await handle.db.run(
        sql`INSERT INTO webhooks (id, url, secret) VALUES (${"37.5,127.25"}, ${"https://hooks.slack.com/services/T0001/B0002/xyz"}, ${"hook-secret-1"}), (${"wydm9q"}, ${null}, ${null})`,
      );
    } catch (e) {
      return e;
    } finally {
      handle.client.close();
    }
    throw new Error("the insert should have failed");
  }

  it("logs a failed query by its SQL and its cause, never its parameters", async () => {
    const err = await failedQuery();
    expect((err as Error).message).toContain("wydm9q");
    log.error("request failed", err);
    const line = written.join("");
    const ring = JSON.stringify(recentLogs());
    for (const leak of LEAKS) {
      expect(line).not.toContain(leak);
      expect(ring).not.toContain(leak);
    }
    expect(line).toContain("SQLITE_CONSTRAINT");
    const [entry] = recentLogs();
    expect(entry!.fields!.err).toMatchObject({
      name: "DrizzleQueryError",
      message: "Failed query: INSERT INTO webhooks (id, url, secret) VALUES (?, ?, ?), (?, ?, ?)",
      cause: { code: "SQLITE_CONSTRAINT" },
    });
  });

  it("keeps the first line of a message, the stack frames, and a bounded chain of causes", () => {
    let err = new Error("level 0\nsecond line with 12.5");
    for (let i = 1; i <= 6; i++) err = new Error(`level ${i}`, { cause: err });
    const out = redactFields({ err }).err as any;
    expect(out.message).toBe("level 6");
    expect(out.stack.every((f: string) => f.startsWith("at "))).toBe(true);
    expect(JSON.stringify(out)).not.toContain("level 2");
    expect(out.cause.cause.cause.message).toBe("level 3");
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

  it("never throws, even for fields it cannot read", () => {
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error("no keys"); } });
    expect(() => log.info("still here", hostile)).not.toThrow();
    expect(written.join("")).toContain("could not be written");
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
