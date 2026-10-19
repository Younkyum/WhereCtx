import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KakaoProvider } from "./kakao.js";
import { NaverProvider } from "./naver.js";
import { PROVIDER_MESSAGE_MAX, providerMessageOf } from "./problems.js";
import { GeoError, type KeyProblem } from "./types.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const KAKAO_KEY = "0123456789abcdef0123456789abcdef";
const NAVER = { clientId: "naver-client-id-1", clientSecret: "naver-secret-abc" };
const SEOUL = { lat: 37.566, lon: 126.978 };
const STATION = { lat: 37.555, lon: 126.971 };

const answering = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

async function refusal(p: Promise<unknown>): Promise<GeoError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(GeoError);
  return e as GeoError;
}

const kakao = (status: number, body: unknown) => new KakaoProvider({ restKey: KAKAO_KEY, fetch: answering(status, body) });
const naver = (status: number, body: unknown) => new NaverProvider({ ...NAVER, fetch: answering(status, body) });

describe("what a Kakao refusal means, from the bodies Kakao sends", () => {
  it("names an unknown key and never repeats it, though Kakao echoes it", async () => {
    const e = await refusal(kakao(401, fixture("kakao-error-unknown-key.json")).reverse(SEOUL));
    expect(e).toMatchObject({ kind: "auth", problem: "key_invalid", providerMessage: "appKey(••••) does not exist" });
    expect(JSON.stringify({ ...e, message: e.message })).not.toContain(KAKAO_KEY);
  });

  it("names the 카카오맵 product being off, which Local needs", async () => {
    const e = await refusal(kakao(403, fixture("kakao-error-map-disabled.json")).geocode("서울시청"));
    expect(e).toMatchObject({
      kind: "auth",
      problem: "map_service_disabled",
      providerMessage: "App(Store Manager App) disabled OPEN_MAP_AND_LOCAL service.",
    });
  });

  it.each<[number, unknown, KeyProblem]>([
    [401, fixture("kakao-navi-error-unknown-key.json"), "key_invalid"],
    [403, { code: -3, msg: "disabled feature" }, "service_not_enabled"],
    [403, { code: -5, msg: "no permission" }, "review_required"],
    [400, { code: -10, msg: "quota exceeded" }, "quota"],
    [400, { code: -2, msg: "bad origin" }, "rejected"],
    [500, { code: -1 }, "upstream"],
  ])("a Mobility %i %j is %s", async (status, body, problem) => {
    const e = await refusal(kakao(status, body).route({ origin: SEOUL, destination: STATION }));
    expect(e.problem).toBe(problem);
    expect(e.providerMessage ?? "").not.toContain(KAKAO_KEY);
  });
});

describe("what a Naver refusal means, from the gateway's bodies", () => {
  it.each<[number, unknown, KeyProblem, string | undefined]>([
    [401, fixture("naver-error-auth.json"), "key_invalid", "Authentication Failed: Invalid authentication information."],
    [401, { error: { errorCode: "210", message: "Permission Denied" } }, "service_not_enabled", "Permission Denied"],
    [429, { error: { errorCode: "400", message: "Quota Exceeded" } }, "service_not_enabled", "Quota Exceeded"],
    [429, { error: { errorCode: "420", message: "Rate Limited" } }, "quota", "Rate Limited"],
    [401, "not json", "key_invalid", undefined],
  ])("%i %j is %s", async (status, body, problem, words) => {
    const e = await refusal(naver(status, body).reverse(SEOUL));
    expect(e.problem).toBe(problem);
    expect(e.providerMessage).toBe(words);
  });

  it("keeps a 429 a quota failure for callers, even when the fix is selecting the API", async () => {
    const e = await refusal(naver(429, { error: { errorCode: "400", message: "Quota Exceeded" } }).geocode("x"));
    expect(e.kind).toBe("quota");
  });

  it("masks the client id and secret when the gateway repeats them", async () => {
    const body = { error: { errorCode: "200", message: "Authentication Failed", details: `bad id ${NAVER.clientId} / ${NAVER.clientSecret}` } };
    const e = await refusal(naver(401, body).reverse(SEOUL));
    expect(e.providerMessage).toBe("Authentication Failed: bad id •••• / ••••");
  });
});

describe("a provider's words as the dashboard may show them", () => {
  it("masks any key-like run, drops control characters and caps the length", () => {
    expect(providerMessageOf("key abcdefghijklmnopqrstuvwxyz0123 gone\u0000‮", [])).toBe("key •••• gone");
    expect([...providerMessageOf("가".repeat(1000), [])!]).toHaveLength(PROVIDER_MESSAGE_MAX);
    expect(providerMessageOf("  ", [])).toBeUndefined();
  });
});
