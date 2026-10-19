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
    ["authorization", "Bearer abc"],
    ["Api-Key", "k"],
    ["X-Api-Key", "k"],
    ["x-n8n-auth", "a value with spaces ~!@#"],
    ["X-Auth-Token", "t"],
    ["X-Service-Key", "k"],
    ["X-Partner-Api-Key", "k"],
    ["X-Hub-Authorization", "a"],
    ["X-Client-Secret", "s"],
    ["X-Receiver-Signature", "s"],
  ])("accepts %s", (name, value) => {
    expect(authHeaderProblem(name, value)).toBeNull();
  });

  it.each([
    ["an empty name", "", "v", "name"],
    ["a name with a space", "X Api", "v", "name"],
    ["a name with a colon", "X-Api:", "v", "name"],
    ["a name with CRLF", "X-Api\r\nHost", "v", "name"],
    ["a name with an underscore", "X_Api_Key", "v", "name"],
    ["__proto__", "__proto__", "v", "name"],
    ["a name over 64 characters", `X-${"a".repeat(59)}-token`, "v", "name"],
    ["Host", "Host", "v", "notAllowed"],
    ["Content-Length", "Content-Length", "v", "notAllowed"],
    ["Content-Type", "content-type", "v", "notAllowed"],
    ["Transfer-Encoding", "Transfer-Encoding", "v", "notAllowed"],
    ["Connection", "CONNECTION", "v", "notAllowed"],
    ["Cookie", "Cookie", "v", "notAllowed"],
    ["User-Agent", "User-Agent", "v", "notAllowed"],
    ["Proxy-Authorization", "Proxy-Authorization", "v", "notAllowed"],
    ["Forwarded", "Forwarded", "v", "notAllowed"],
    ["X-Forwarded-For", "X-Forwarded-For", "v", "notAllowed"],
    ["X-Forwarded-Host", "X-Forwarded-Host", "v", "notAllowed"],
    ["X-Real-IP", "X-Real-IP", "v", "notAllowed"],
    ["X-HTTP-Method-Override", "X-HTTP-Method-Override", "v", "notAllowed"],
    ["X-Original-URL", "X-Original-URL", "v", "notAllowed"],
    ["Metadata", "Metadata", "v", "notAllowed"],
    ["Metadata-Flavor", "Metadata-Flavor", "v", "notAllowed"],
    ["Origin", "Origin", "v", "notAllowed"],
    ["Referer", "Referer", "v", "notAllowed"],
    ["a bare X-Token", "X-Token", "v", "notAllowed"],
    ["a suffix without the X- prefix", "Service-Token", "v", "notAllowed"],
    ["the dispatcher's signature header", "X-WhereCtx-Signature", "v", "notAllowed"],
    ["a WhereCtx-prefixed token", "x-wherectx-auth-token", "v", "notAllowed"],
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
    const name = `X-${"a".repeat(56)}-token`;
    expect(name).toHaveLength(64);
    expect(authHeaderProblem(name, "x".repeat(1024))).toBeNull();
  });
});

describe("authHeaderHint", () => {
  const token20 = "abcdefghijklmnop1234";
  const token40 = `${"z".repeat(36)}9f3k`;

  it.each([
    ["a short bearer token", "Bearer abcde", "…"],
    ["a 19-character token", `Bearer ${token20.slice(1)}`, "…"],
    ["a 20-character token", `Bearer ${token20}`, "…1234"],
    ["a 40-character token", `Bearer ${token40}`, "…9f3k"],
    ["a 20-character value without a scheme", token20, "…1234"],
    ["a scheme that would pad a short token past 20", "Bearer-scheme-long abc", "…"],
    ["Basic credentials", `Basic ${Buffer.from("user:correct-horse-battery").toString("base64")}`, "…"],
    ["Basic in another case", `basic ${"Q".repeat(40)}`, "…"],
  ])("shows %s as %s", (_case, value, hint) => {
    expect(authHeaderHint(value)).toBe(hint);
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

  it("fails closed under another key, or with none: the hook is not delivered but is listed as unreadable", async () => {
    await new WebhooksStore(handle.db, clock, new SecretBox("key-A")).create(USER, {
      url: "https://example.test/hook",
      events: ["*"],
      authHeader: header,
    });
    for (const store of [new WebhooksStore(handle.db, clock, new SecretBox("key-B")), new WebhooksStore(handle.db, clock)]) {
      expect(await store.listActive()).toEqual([]);
      const listed = await store.list(USER);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ credentialsUnreadable: true });
      expect(listed[0]).not.toHaveProperty("authHeader");
      expect(await store.count(USER)).toBe(1);
    }
  });

  async function copyAuthHeader(from: string, to: string): Promise<void> {
    await handle.client.execute({
      sql: "UPDATE webhooks SET auth_header = (SELECT auth_header FROM webhooks WHERE id = ?) WHERE id = ?",
      args: [from, to],
    });
  }

  it("does not open when copied onto another of the same person's hooks", async () => {
    const store = new WebhooksStore(handle.db, clock, new SecretBox("install-key"));
    const mine = await store.create(USER, { url: "https://example.test/mine", events: ["*"], authHeader: header });
    const other = await store.create(USER, { url: "https://example.test/other", events: ["*"] });
    await copyAuthHeader(mine.id, other.id);
    expect((await store.listActive()).map((h) => h.id)).toEqual([mine.id]);
  });

  it("does not open when copied onto another person's hook", async () => {
    const store = new WebhooksStore(handle.db, clock, new SecretBox("install-key"));
    const mine = await store.create(USER, { url: "https://example.test/mine", events: ["*"], authHeader: header });
    const theirs = await store.create(OTHER, { url: "https://example.test/theirs", events: ["*"] });
    await copyAuthHeader(mine.id, theirs.id);
    expect((await store.listActive()).map((h) => h.id)).toEqual([mine.id]);
  });

  it("does not open when its row is moved to another person with the same hook id", async () => {
    const store = new WebhooksStore(handle.db, clock, new SecretBox("install-key"));
    const mine = await store.create(USER, { url: "https://example.test/mine", events: ["*"], authHeader: header });
    await handle.client.execute({ sql: "UPDATE webhooks SET user_id = ? WHERE id = ?", args: [OTHER, mine.id] });
    expect(await store.listActive()).toEqual([]);
    expect((await store.list(OTHER))[0]).toMatchObject({ id: mine.id, credentialsUnreadable: true });
  });

  it("keeps every other hook deliverable when one row is corrupt, and logs the corrupt one once", async () => {
    const { clearLogs, recentLogs } = await import("../util/log.js");
    const store = new WebhooksStore(handle.db, clock, new SecretBox("install-key"));
    const broken = await store.create(USER, { url: "https://example.test/broken", events: ["*"], authHeader: header });
    const fine = await store.create(USER, { url: "https://example.test/fine", events: ["*"], authHeader: { name: "X-Api-Key", value: "fine-key-0123456789abcd" } });
    const plain = await store.create(OTHER, { url: "https://example.test/plain", events: ["*"] });
    await handle.client.execute({ sql: "UPDATE webhooks SET auth_header = 'enc:v1:AAAA' WHERE id = ?", args: [broken.id] });
    clearLogs();
    for (let i = 0; i < 3; i++) {
      expect((await store.listActive()).map((h) => h.id).sort()).toEqual([fine.id, plain.id].sort());
    }
    const mentions = recentLogs().filter((l) => JSON.stringify(l).includes(broken.id));
    expect(mentions).toHaveLength(1);
  });

  it.each([
    ["a reserved name", { name: "Host", value: "x" }],
    ["__proto__ as the name", { name: "__proto__", value: "x" }],
    ["a value with a line break", { name: "Authorization", value: "a\r\nb" }],
    ["a missing value", { name: "Authorization" }],
  ])("fails closed when the opened header has %s", async (_case, opened) => {
    const box = new SecretBox("install-key");
    const store = new WebhooksStore(handle.db, clock, box);
    const hook = await store.create(USER, { url: "https://example.test/hook", events: ["*"], authHeader: header });
    const sealed = box.encrypt(JSON.stringify(opened), `webhook-auth|${USER}|${hook.id}`);
    await handle.client.execute({ sql: "UPDATE webhooks SET auth_header = ? WHERE id = ?", args: [sealed, hook.id] });
    expect(await store.listActive()).toEqual([]);
    expect((await store.list(USER))[0]).toMatchObject({ credentialsUnreadable: true });
  });

  it("is replaced and removed by update, only on the owner's hook", async () => {
    const store = new WebhooksStore(handle.db, clock, new SecretBox("install-key"));
    const hook = await store.create(USER, { url: "https://example.test/hook", events: ["*"], authHeader: header });
    const replaced = { name: "X-Api-Key", value: "replacement-credential-0042" };
    expect(await store.update(OTHER, hook.id, { authHeader: null })).toBeNull();
    expect((await store.list(USER))[0]).toMatchObject({ authHeader: header });
    expect(await store.update(USER, hook.id, { authHeader: replaced })).toMatchObject({ authHeader: replaced });
    expect((await store.list(USER))[0]).toMatchObject({ authHeader: replaced });
    expect(await store.update(USER, hook.id, { authHeader: null })).not.toHaveProperty("authHeader");
    expect(await rawAuthHeaders()).toEqual(["null"]);
  });

  it("is never stored in the clear: a store without a key refuses one", async () => {
    const plain = new WebhooksStore(handle.db, clock);
    expect(plain.sealsAuthHeaders).toBe(false);
    await expect(plain.create(USER, { url: "https://example.test/hook", events: ["*"], authHeader: header })).rejects.toThrow(
      "WEBHOOK_ENCRYPTION_KEY",
    );
    const hook = await plain.create(USER, { url: "https://example.test/hook", events: ["*"] });
    await expect(plain.update(USER, hook.id, { authHeader: header })).rejects.toThrow("WEBHOOK_ENCRYPTION_KEY");
    expect(await rawAuthHeaders()).toEqual(["null"]);
  });

  it("is not delivered when found unencrypted, is counted for the boot warning, and is not sealed in place", async () => {
    const keyed = new WebhooksStore(handle.db, clock, new SecretBox("install-key"));
    const hook = await keyed.create(USER, { url: "https://example.test/hook", events: ["*"] });
    await handle.client.execute({ sql: "UPDATE webhooks SET auth_header = ? WHERE id = ?", args: [JSON.stringify(header), hook.id] });
    expect(await keyed.undeliverableAuthHeaders()).toBe(1);
    expect(await keyed.encryptLegacySecrets()).toBe(0);
    expect(await rawAuthHeaders()).toEqual([JSON.stringify(header)]);
    expect(await keyed.listActive()).toEqual([]);
    expect((await keyed.list(USER))[0]).toMatchObject({ credentialsUnreadable: true });

    expect(await keyed.update(USER, hook.id, { authHeader: header })).toMatchObject({ authHeader: header });
    expect(await keyed.undeliverableAuthHeaders()).toBe(0);
    expect((await keyed.listActive()).map((h) => h.id)).toEqual([hook.id]);
  });
});
