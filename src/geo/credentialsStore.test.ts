import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, ensureSchema, type DbHandle } from "../db/index.js";
import { asUserId } from "../types.js";
import { SecretBox } from "../webhooks/secretBox.js";
import { GeoCredentialsStore, UNUSABLE_KEY } from "./credentialsStore.js";
import { GEO_CACHE_TTL_MS, GeoCacheStore, cacheTtlMs } from "./cacheStore.js";
import { SettingsStore } from "../privacy/settingsStore.js";
import { testConfig } from "../testing/accounts.js";

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
  const cell = { lat: 37.5664321, lon: 126.9781234 };
  const region = { region1: "서울특별시", region2: "중구", region3: "명동", label: "중구 명동" };
  const WEEK = GEO_CACHE_TTL_MS;
  let cache: GeoCacheStore;
  beforeEach(() => {
    cache = new GeoCacheStore(handle.db, "install-cache-key", () => new Date(now));
  });

  it("answers per person and provider, and forgets after seven days", async () => {
    await cache.put(ana, "kakao", cell, region, WEEK);
    expect(await cache.get(ana, "kakao", { lat: 37.566, lon: 126.978 }, WEEK)).toEqual({ hit: true, result: region });
    expect(await cache.get(ben, "kakao", cell, WEEK)).toEqual({ hit: false });
    expect(await cache.get(ana, "naver", cell, WEEK)).toEqual({ hit: false });
    now += WEEK + 1;
    expect(await cache.get(ana, "kakao", cell, WEEK)).toEqual({ hit: false });
    expect(await cache.prune()).toBe(1);
  });

  it("keys rows by an HMAC, so the table holds no coordinates, and another install's key finds nothing", async () => {
    await cache.put(ana, "kakao", cell, region, WEEK);
    const raw = JSON.stringify((await handle.client.execute("SELECT * FROM geo_cache")).rows);
    expect(raw).not.toMatch(/37\.56|126\.97/);
    const other = new GeoCacheStore(handle.db, "another-install", () => new Date(now));
    expect(await other.get(ana, "kakao", cell, WEEK)).toEqual({ hit: false });
  });

  it("keeps an answer no longer than the person's retentionHours", async () => {
    expect(cacheTtlMs(24)).toBe(86_400_000);
    expect(cacheTtlMs(24 * 30)).toBe(WEEK);
    expect(cacheTtlMs(0)).toBe(0);
    await cache.put(ana, "kakao", cell, region, 0);
    expect(await handle.client.execute("SELECT * FROM geo_cache").then((r) => r.rows)).toHaveLength(0);

    const settings = new SettingsStore(handle.db, testConfig(), () => new Date(now));
    await settings.update(ana, { retentionHours: 2 });
    await settings.update(ben, { retentionHours: 720 });
    await cache.put(ana, "kakao", cell, region, cacheTtlMs(2));
    await cache.put(ben, "kakao", cell, region, WEEK);
    now += 3 * 3_600_000;
    expect(await cache.get(ana, "kakao", cell, cacheTtlMs(2))).toEqual({ hit: false });
    expect(await cache.prune()).toBe(1);
    expect(await cache.get(ben, "kakao", cell, WEEK)).toMatchObject({ hit: true });
  });

  it("purges one person's answers only", async () => {
    await cache.put(ana, "kakao", cell, region, WEEK);
    await cache.put(ben, "kakao", cell, region, WEEK);
    expect(await cache.purge(ana)).toBe(1);
    expect(await cache.get(ben, "kakao", cell, WEEK)).toMatchObject({ hit: true });
  });
});
