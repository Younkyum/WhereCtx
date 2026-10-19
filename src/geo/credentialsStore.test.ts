import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, ensureSchema, type DbHandle } from "../db/index.js";
import { asUserId } from "../types.js";
import { SecretBox } from "../webhooks/secretBox.js";
import { GeoCredentialsStore, UNUSABLE_KEY } from "./credentialsStore.js";
import { GeoCacheStore } from "./cacheStore.js";

const ana = asUserId("ana");
const ben = asUserId("ben");
const KAKAO_KEY = "0123456789abcdef0123456789abcdef";
const NAVER = { provider: "naver" as const, clientId: "naver-client-id-7x9q", clientSecret: "naver-client-secret-QQQQ" };

let handle: DbHandle;
let now: number;
let store: GeoCredentialsStore;

beforeEach(async () => {
  handle = createDb(":memory:");
  await ensureSchema(handle);
  now = Date.parse("2026-10-19T00:00:00Z");
  store = new GeoCredentialsStore(handle.db, new SecretBox("install-key"), () => new Date(now));
});

afterEach(() => handle.client.close());

async function rawRows(): Promise<string> {
  const rows = await handle.client.execute("SELECT * FROM geo_credentials");
  return JSON.stringify(rows.rows);
}

describe("maps credentials at rest", () => {
  it("stores no key in plaintext, and lists only a hint", async () => {
    await store.put(ana, "kakao", { restKey: KAKAO_KEY });
    await store.put(ana, "naver", { clientId: NAVER.clientId, clientSecret: NAVER.clientSecret });
    const raw = await rawRows();
    for (const secret of [KAKAO_KEY, NAVER.clientSecret, NAVER.clientId]) expect(raw).not.toContain(secret);
    expect(raw).toContain("enc:v1:");
    const listed = await store.list(ana);
    expect(listed).toEqual([
      expect.objectContaining({ provider: "kakao", kinds: { restKey: "cdef" }, lastUsedAt: null, lastError: null }),
      expect.objectContaining({ provider: "naver", kinds: { clientId: "7x9q", clientSecret: "" } }),
    ]);
    expect(JSON.stringify(listed)).not.toContain(KAKAO_KEY);
  });

  it("opens a key only for its owner", async () => {
    await store.put(ana, "kakao", { restKey: KAKAO_KEY });
    expect(await store.open(ana, "kakao")).toEqual({ restKey: KAKAO_KEY });
    expect(await store.open(ben, "kakao")).toBeNull();
    expect(await store.list(ben)).toEqual([]);
    expect(await store.delete(ben, "kakao")).toBe(false);
    expect(await store.open(ana, "kakao")).not.toBeNull();
  });

  it("cannot be opened with another install's key, and says so instead of failing", async () => {
    await store.put(ana, "kakao", { restKey: KAKAO_KEY });
    const other = new GeoCredentialsStore(handle.db, new SecretBox("another-install"));
    expect(await other.open(ana, "kakao")).toBeNull();
    expect(await other.list(ana)).toEqual([expect.objectContaining({ provider: "kakao", status: "unusable", lastError: UNUSABLE_KEY })]);
  });

  it("is bound to its person and provider: a row copied to another does not open", async () => {
    await store.put(ana, "kakao", { restKey: KAKAO_KEY });
    await store.put(ben, "kakao", { restKey: "ben-key-0000000000000000" });
    await handle.client.execute(
      "UPDATE geo_credentials SET secret = (SELECT secret FROM geo_credentials WHERE user_id = 'ana') WHERE user_id = 'ben'",
    );
    expect(await store.open(ben, "kakao")).toBeNull();
    expect((await store.list(ben))[0]!.status).toBe("unusable");
    expect(await store.open(ana, "kakao")).toEqual({ restKey: KAKAO_KEY });
  });

  it("treats a corrupted, unsealed or incomplete row as unusable, and still replaces or removes it", async () => {
    await store.put(ana, "kakao", { restKey: KAKAO_KEY });
    await store.put(ana, "naver", { clientId: NAVER.clientId, clientSecret: NAVER.clientSecret });
    await handle.client.execute("UPDATE geo_credentials SET secret = 'enc:v1:AAAAbroken' WHERE provider = 'kakao'");
    await handle.client.execute({ sql: "UPDATE geo_credentials SET secret = ? WHERE provider = 'naver'", args: [JSON.stringify({ clientId: "x" })] });
    expect((await store.list(ana)).map((c) => [c.provider, c.status])).toEqual([
      ["kakao", "unusable"],
      ["naver", "unusable"],
    ]);
    expect(await store.open(ana, "kakao")).toBeNull();
    await store.put(ana, "kakao", { restKey: KAKAO_KEY });
    expect(await store.open(ana, "kakao")).toEqual({ restKey: KAKAO_KEY });
    expect(await store.delete(ana, "naver")).toBe(true);
    expect((await store.list(ana)).map((c) => [c.provider, c.status])).toEqual([["kakao", "ok"]]);

    const incomplete = await store.put(ana, "naver", { clientId: NAVER.clientId });
    expect(incomplete.status).toBe("unusable");
  });

  it("replacing a key clears how the old one fared", async () => {
    await store.put(ana, "kakao", { restKey: KAKAO_KEY });
    await store.markUsed(ana, "kakao", "the maps provider refused the key");
    expect((await store.list(ana))[0]!.lastError).toBe("the maps provider refused the key");
    await store.put(ana, "kakao", { restKey: "fedcba9876543210fedcba9876543210" });
    expect((await store.list(ana))[0]).toMatchObject({ kinds: { restKey: "3210" }, lastError: null, lastUsedAt: null });
  });

  it("a save replaces the whole bag; it can still hold more than the REST kinds", async () => {
    await store.put(ana, "kakao", { restKey: KAKAO_KEY, jsKey: "javascript-key-abcd" });
    expect(await store.open(ana, "kakao")).toEqual({ restKey: KAKAO_KEY, jsKey: "javascript-key-abcd" });
    await store.put(ana, "kakao", { restKey: KAKAO_KEY });
    expect(await store.open(ana, "kakao")).toEqual({ restKey: KAKAO_KEY });
  });
});

describe("the reverse geocoding cache", () => {
  it("answers per person and provider, and forgets after seven days", async () => {
    const cache = new GeoCacheStore(handle.db, () => new Date(now));
    const cell = { lat: 37.566, lon: 126.978 };
    const region = { region1: "서울특별시", region2: "중구", region3: "명동", label: "중구 명동" };
    await cache.put(ana, "kakao", cell, region);
    expect(await cache.get(ana, "kakao", cell)).toEqual({ hit: true, result: region });
    expect(await cache.get(ben, "kakao", cell)).toEqual({ hit: false });
    expect(await cache.get(ana, "naver", cell)).toEqual({ hit: false });
    now += 7 * 86_400_000 + 1;
    expect(await cache.get(ana, "kakao", cell)).toEqual({ hit: false });
    expect(await cache.prune()).toBe(1);
  });
});
