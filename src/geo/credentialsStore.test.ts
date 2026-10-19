import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, ensureSchema, type DbHandle } from "../db/index.js";
import { asUserId } from "../types.js";
import { SecretBox } from "../webhooks/secretBox.js";
import { GeoCredentialsStore } from "./credentialsStore.js";
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

  it("cannot be opened with another install's key", async () => {
    await store.put(ana, "kakao", { restKey: KAKAO_KEY });
    const other = new GeoCredentialsStore(handle.db, new SecretBox("another-install"));
    await expect(other.open(ana, "kakao")).rejects.toThrow();
  });

  it("refuses a row that is not sealed", async () => {
    await store.put(ana, "kakao", { restKey: KAKAO_KEY });
    await handle.client.execute({ sql: "UPDATE geo_credentials SET secret = ?", args: [JSON.stringify({ restKey: KAKAO_KEY })] });
    await expect(store.open(ana, "kakao")).rejects.toThrow(/not sealed/);
  });

  it("replacing a key clears how the old one fared", async () => {
    await store.put(ana, "kakao", { restKey: KAKAO_KEY });
    await store.markUsed(ana, "kakao", "the maps provider refused the key");
    expect((await store.list(ana))[0]!.lastError).toBe("the maps provider refused the key");
    await store.put(ana, "kakao", { restKey: "fedcba9876543210fedcba9876543210" });
    expect((await store.list(ana))[0]).toMatchObject({ kinds: { restKey: "3210" }, lastError: null, lastUsedAt: null });
  });

  it("keeps the kinds a save does not name, and removes one set to null", async () => {
    await store.put(ana, "kakao", { restKey: KAKAO_KEY });
    await store.put(ana, "kakao", { jsKey: "javascript-key-abcd" });
    expect(await store.open(ana, "kakao")).toEqual({ restKey: KAKAO_KEY, jsKey: "javascript-key-abcd" });
    await store.put(ana, "kakao", { jsKey: null });
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
