import { beforeEach, describe, expect, it } from "vitest";
import { createDb, ensureSchema, type DbHandle } from "../db/index.js";
import { WebhooksStore } from "../store/webhooksStore.js";
import { asUserId } from "../types.js";
import { authHeaderHint, authHeaderProblem } from "./authHeader.js";
import { SecretBox } from "./secretBox.js";

const USER = asUserId("default");
const OTHER = asUserId("other");
const VALUE = "Bearer n8n-header-credential-9f3k";
const header = { name: "Authorization", value: VALUE };
const clock = () => new Date("2026-06-05T00:00:00.000Z");

let handle: DbHandle;

async function rawAuthHeaders(): Promise<string[]> {
  const rows = await handle.client.execute("SELECT auth_header FROM webhooks");
  return rows.rows.map((r) => String(r["auth_header"]));
}

beforeEach(async () => {
  handle = createDb(":memory:");
  await ensureSchema(handle);
});

describe("authHeaderProblem", () => {
  it.each([
    ["Authorization", "Bearer abc"],
    ["X-Api-Key", "k"],
    ["x-n8n-auth", "a value with spaces ~!@#"],
  ])("accepts %s", (name, value) => {
    expect(authHeaderProblem(name, value)).toBeNull();
  });

  it.each([
    ["an empty name", "", "v", "name"],
    ["a name with a space", "X Api", "v", "name"],
    ["a name with a colon", "X-Api:", "v", "name"],
    ["a name with CRLF", "X-Api\r\nHost", "v", "name"],
    ["a name over 64 characters", "X".repeat(65), "v", "name"],
    ["Host", "Host", "v", "reserved"],
    ["content-length", "Content-Length", "v", "reserved"],
    ["Content-Type", "content-type", "v", "reserved"],
    ["Transfer-Encoding", "Transfer-Encoding", "v", "reserved"],
    ["Connection", "CONNECTION", "v", "reserved"],
    ["Upgrade", "Upgrade", "v", "reserved"],
    ["TE", "te", "v", "reserved"],
    ["Trailer", "Trailer", "v", "reserved"],
    ["Keep-Alive", "Keep-Alive", "v", "reserved"],
    ["a proxy header", "Proxy-Authorization", "v", "reserved"],
    ["Cookie", "Cookie", "v", "reserved"],
    ["User-Agent", "User-Agent", "v", "reserved"],
    ["the dispatcher's signature header", "X-WhereCtx-Signature", "v", "reserved"],
    ["the dispatcher's event header", "x-wherectx-event", "v", "reserved"],
    ["an empty value", "Authorization", "", "value"],
    ["a value with CRLF", "Authorization", "Bearer a\r\nX-Evil: 1", "value"],
    ["a value with LF", "Authorization", "Bearer a\nb", "value"],
    ["a value with a tab", "Authorization", "Bearer\ta", "value"],
    ["a value with a NUL", "Authorization", "Bearer a\u0000", "value"],
    ["a non-ASCII value", "Authorization", "Bearer 토큰", "value"],
    ["a value over 1024 characters", "Authorization", "x".repeat(1025), "value"],
  ])("refuses %s", (_case, name, value, problem) => {
    expect(authHeaderProblem(name, value)).toBe(problem);
  });

  it("accepts a 64-character name and a 1024-character value", () => {
    expect(authHeaderProblem("X".repeat(64), "x".repeat(1024))).toBeNull();
  });
});

describe("authHeaderHint", () => {
  it("shows the last four characters of a long value, nothing of a short one", () => {
    expect(authHeaderHint(VALUE)).toBe("…9f3k");
    expect(authHeaderHint("Bearer abc")).toBe("…");
  });
});

describe("a webhook's auth header at rest", () => {
  it("is sealed in the row and opens on read", async () => {
    const store = new WebhooksStore(handle.db, clock, new SecretBox("install-key"));
    await store.create(USER, { url: "https://example.test/hook", events: ["*"], authHeader: header });
    const [raw] = await rawAuthHeaders();
    expect(raw!.startsWith("enc:v1:")).toBe(true);
    expect(raw).not.toContain(VALUE);
    expect(raw).not.toContain("9f3k");
    expect((await store.list(USER))[0]!.authHeader).toEqual(header);
  });

  it("fails closed under another key: the hook is not listed for delivery", async () => {
    await new WebhooksStore(handle.db, clock, new SecretBox("key-A")).create(USER, {
      url: "https://example.test/hook",
      events: ["*"],
      authHeader: header,
    });
    expect(await new WebhooksStore(handle.db, clock, new SecretBox("key-B")).listActive()).toEqual([]);
    expect(await new WebhooksStore(handle.db, clock).listActive()).toEqual([]);
  });

  it("does not open when copied onto another person's hook", async () => {
    const store = new WebhooksStore(handle.db, clock, new SecretBox("install-key"));
    const mine = await store.create(USER, { url: "https://example.test/mine", events: ["*"], authHeader: header });
    const theirs = await store.create(OTHER, { url: "https://example.test/theirs", events: ["*"] });
    await handle.client.execute({
      sql: "UPDATE webhooks SET auth_header = (SELECT auth_header FROM webhooks WHERE id = ?) WHERE id = ?",
      args: [mine.id, theirs.id],
    });
    expect((await store.listActive()).map((h) => h.id)).toEqual([mine.id]);
  });

  it("is replaced and removed by update, only on the owner's hook", async () => {
    const store = new WebhooksStore(handle.db, clock, new SecretBox("install-key"));
    const hook = await store.create(USER, { url: "https://example.test/hook", events: ["*"], authHeader: header });
    const replaced = { name: "X-Api-Key", value: "replacement-credential-0042" };
    expect(await store.update(OTHER, hook.id, { authHeader: null })).toBeNull();
    expect((await store.list(USER))[0]!.authHeader).toEqual(header);
    expect((await store.update(USER, hook.id, { authHeader: replaced }))!.authHeader).toEqual(replaced);
    expect((await store.list(USER))[0]!.authHeader).toEqual(replaced);
    expect((await store.update(USER, hook.id, { authHeader: null }))!.authHeader).toBeUndefined();
    expect(await rawAuthHeaders()).toEqual(["null"]);
  });

  it("is stored in the clear without a key, warned about, and sealed once a key is set", async () => {
    await new WebhooksStore(handle.db, clock).create(USER, { url: "https://example.test/hook", events: ["*"], authHeader: header });
    const plain = new WebhooksStore(handle.db, clock);
    expect(await plain.hasPlaintextSecrets()).toBe(true);

    const keyed = new WebhooksStore(handle.db, clock, new SecretBox("install-key"));
    expect(await keyed.encryptLegacySecrets()).toBe(1);
    expect(await keyed.encryptLegacySecrets()).toBe(0);
    expect(await plain.hasPlaintextSecrets()).toBe(false);
    const [raw] = await rawAuthHeaders();
    expect(raw).not.toContain(VALUE);
    expect((await keyed.list(USER))[0]!.authHeader).toEqual(header);
  });
});
