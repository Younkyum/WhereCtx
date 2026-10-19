import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KakaoProvider, kakaoDepartureTime } from "./kakao.js";
import { NaverProvider } from "./naver.js";
import { GEO_MAX_BODY_BYTES, PROVIDER_TEXT_MAX } from "./http.js";
import { GeoError, roundingProvider } from "./types.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

interface Sent {
  url: URL;
  headers: Record<string, string>;
}

/** A fetch that answers each request with the next reply, and keeps what was sent. */
function stubFetch(...replies: Array<{ status?: number; body: unknown } | "timeout" | "network">) {
  const sent: Sent[] = [];
  const fn = (async (input: URL | string, init?: RequestInit) => {
    sent.push({ url: new URL(String(input)), headers: init?.headers as Record<string, string> });
    const reply = replies.shift();
    if (!reply) throw new Error("unexpected request");
    if (reply === "timeout") throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    if (reply === "network") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  }) as typeof fetch;
  return { fn, sent };
}

const NOW = new Date("2026-10-19T03:00:00.000Z");
const A = { lat: 37.402, lon: 127.108 };
const B = { lat: 37.394, lon: 127.11 };

async function failure(p: Promise<unknown>): Promise<GeoError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(GeoError);
  const error = e as GeoError;
  expect(error.message).not.toMatch(/\d+\.\d{3}/);
  return error;
}

describe("Kakao adapter, against the documented samples", () => {
  const kakao = (stub: ReturnType<typeof stubFetch>) => new KakaoProvider({ restKey: "kakao-key", fetch: stub.fn, now: () => NOW });

  it("geocodes an address with the KakaoAK header", async () => {
    const stub = stubFetch({ body: fixture("kakao-address.json") });
    const out = await kakao(stub).geocode("전북 익산시 부송동 100");
    expect(out).toEqual([
      {
        label: "전북 익산시 망산길 11-17",
        address: "전북 익산시 부송동 100",
        roadAddress: "전북 익산시 망산길 11-17",
        lat: 35.97664845766847,
        lon: 126.99597295767953,
        kind: "address",
      },
    ]);
    expect(stub.sent[0]!.url.origin + stub.sent[0]!.url.pathname).toBe("https://dapi.kakao.com/v2/local/search/address.json");
    expect(stub.sent[0]!.headers.Authorization).toBe("KakaoAK kakao-key");
  });

  it("falls back to keyword search when no address matches", async () => {
    const stub = stubFetch({ body: { meta: { total_count: 0 }, documents: [] } }, { body: fixture("kakao-keyword.json") });
    const out = await kakao(stub).geocode("카카오프렌즈");
    expect(stub.sent[1]!.url.pathname).toBe("/v2/local/search/keyword.json");
    expect(out[0]).toEqual({
      label: "카카오프렌즈 코엑스점",
      address: "서울 강남구 삼성동 159",
      roadAddress: "서울 강남구 영동대로 513",
      lat: 37.51207412593136,
      lon: 127.05902969025047,
      kind: "place",
    });
  });

  it("reverse geocodes to the administrative dong, x as longitude", async () => {
    const stub = stubFetch({ body: fixture("kakao-coord2regioncode.json") });
    const out = await kakao(stub).reverse({ lat: 37.402, lon: 127.104 });
    expect(out).toEqual({ region1: "경기도", region2: "성남시 분당구", region3: "삼평동", label: "성남시 분당구 삼평동" });
    expect(stub.sent[0]!.url.pathname).toBe("/v2/local/geo/coord2regioncode.json");
    expect(stub.sent[0]!.url.searchParams.get("x")).toBe("127.104");
    expect(stub.sent[0]!.url.searchParams.get("y")).toBe("37.402");
  });

  it("routes now with live traffic: duration, distance, fares, main roads, turns", async () => {
    const stub = stubFetch({ body: fixture("kakao-directions.json") });
    const out = await kakao(stub).route({ origin: A, destination: B, avoid: ["toll", "ferries"] });
    expect(out).toEqual({
      durationSec: 3494,
      distanceM: 19032,
      traffic: "live",
      tollFare: 0,
      taxiFare: 22200,
      roads: [
        { name: "판교역로241번길", distanceM: 186, path: [{ lat: 37.40241072822385, lon: 127.10763122680424 }, { lat: 37.40322184743522, lon: 127.10645821495126 }] },
        { name: "문형산길", distanceM: 596, path: [{ lat: 37.36601233289304, lon: 127.16765984810529 }, { lat: 37.36708073181059, lon: 127.17352998262038 }] },
        expect.objectContaining({ name: "문형산안길1번길", distanceM: 85 }),
        expect.objectContaining({ name: "", distanceM: 14 }),
      ],
      steps: ["우회전"],
      departAt: NOW.toISOString(),
    });
    expect(out.roads[2]!.path).toHaveLength(5);
    const url = stub.sent[0]!.url;
    expect(`${url.origin}${url.pathname}`).toBe("https://apis-navi.kakaomobility.com/v1/directions");
    expect(url.searchParams.get("origin")).toBe("127.108,37.402");
    expect(url.searchParams.get("destination")).toBe("127.11,37.394");
    expect(url.searchParams.get("avoid")).toBe("toll|ferries");
    expect(url.searchParams.has("departure_time")).toBe(false);
  });

  it("routes a future departure on the future endpoint, in KST", async () => {
    const stub = stubFetch({ body: fixture("kakao-directions.json") });
    const at = new Date("2026-10-19T09:30:00.000Z");
    const out = await kakao(stub).route({ origin: A, destination: B, departAt: at });
    expect(stub.sent[0]!.url.pathname).toBe("/v1/future/directions");
    expect(stub.sent[0]!.url.searchParams.get("departure_time")).toBe("202610191830");
    expect(out.traffic).toBe("predicted");
    expect(out.departAt).toBe(at.toISOString());
    expect(kakaoDepartureTime(new Date("2026-12-31T15:05:00Z"))).toBe("202701010005");
  });

  it("maps a result_code other than 0 to no_route", async () => {
    const stub = stubFetch({ body: { trans_id: "x", routes: [{ result_code: 104, result_msg: "출발지와 도착지가 5 m 이내로 설정된 경우 경로를 탐색할 수 없음" }] } });
    expect((await failure(kakao(stub).route({ origin: A, destination: A }))).kind).toBe("no_route");
  });

  it.each([
    [{ status: 401, body: { code: -401, msg: "invalid key" } }, "auth"],
    [{ status: 403, body: { code: -5, msg: "no permission" } }, "auth"],
    [{ status: 400, body: { code: -10, msg: "quota" } }, "quota"],
    [{ status: 429, body: {} }, "quota"],
    [{ status: 400, body: { code: -2, msg: "bad" } }, "bad_request"],
    [{ status: 500, body: { code: -1 } }, "upstream"],
    [{ status: 200, body: { routes: "nope" } }, "upstream"],
    ["timeout", "timeout"],
    ["network", "upstream"],
  ] as const)("maps %j to %s", async (reply, kind) => {
    const stub = stubFetch(reply);
    expect((await failure(kakao(stub).route({ origin: A, destination: B }))).kind).toBe(kind);
  });
});

describe("Naver adapter, against the documented samples", () => {
  const naver = (stub: ReturnType<typeof stubFetch>) =>
    new NaverProvider({ clientId: "id", clientSecret: "secret", fetch: stub.fn, now: () => NOW });

  it("geocodes with the API gateway headers on maps.apigw.ntruss.com", async () => {
    const stub = stubFetch({ body: fixture("naver-geocode.json") });
    const out = await naver(stub).geocode("분당구 불정로 6");
    expect(out).toEqual([
      {
        label: "경기도 성남시 분당구 불정로 6 NAVER그린팩토리",
        address: "경기도 성남시 분당구 정자동 178-1 NAVER그린팩토리",
        roadAddress: "경기도 성남시 분당구 불정로 6 NAVER그린팩토리",
        lat: 37.3595963,
        lon: 127.1054328,
        kind: "address",
      },
    ]);
    const { url, headers } = stub.sent[0]!;
    expect(`${url.origin}${url.pathname}`).toBe("https://maps.apigw.ntruss.com/map-geocode/v2/geocode");
    expect(headers["x-ncp-apigw-api-key-id"]).toBe("id");
    expect(headers["x-ncp-apigw-api-key"]).toBe("secret");
  });

  it("reverse geocodes to admcode region names only", async () => {
    const stub = stubFetch({ body: fixture("naver-reversegeocode.json") });
    const out = await naver(stub).reverse({ lat: 34.977, lon: 127.585 });
    expect(out).toEqual({ region1: "전라남도", region2: "광양시", region3: "광양읍", label: "광양시 광양읍" });
    expect(stub.sent[0]!.url.searchParams.get("coords")).toBe("127.585,34.977");
    expect(stub.sent[0]!.url.searchParams.get("orders")).toBe("admcode");
    expect(stub.sent[0]!.url.searchParams.get("output")).toBe("json");
  });

  it("answers null for a point with no address (status code 3)", async () => {
    const stub = stubFetch({ body: { status: { code: 3, name: "no results", message: "" }, results: [] } });
    expect(await naver(stub).reverse({ lat: 37.567, lon: 125.991 })).toBeNull();
  });

  it("routes with live traffic; duration from milliseconds", async () => {
    const stub = stubFetch({ body: fixture("naver-directions5.json") });
    const out = await naver(stub).route({ origin: A, destination: B });
    expect(out).toEqual({
      durationSec: 15857,
      distanceM: 380044,
      traffic: "live",
      tollFare: 21000,
      taxiFare: 352360,
      // The documented sample's path holds two points, so its sections (from point 315 on) have none.
      roads: [
        { name: "경부고속도로", distanceM: 95575, path: [] },
        { name: "상주영천고속도로", distanceM: 92508, path: [] },
        { name: "경부고속도로", distanceM: 89391, path: [] },
      ],
      steps: ["머내공원사거리에서 '서분당(고기)IC' 방면으로 우회전"],
      departAt: NOW.toISOString(),
    });
    const url = stub.sent[0]!.url;
    expect(url.pathname).toBe("/map-direction/v1/driving");
    expect(url.searchParams.get("start")).toBe("127.108,37.402");
    expect(url.searchParams.get("goal")).toBe("127.11,37.394");
    expect(url.searchParams.get("option")).toBe("traoptimal");
  });

  it("maps avoid to the matching option, and refuses what Directions 5 cannot do", async () => {
    const stub = stubFetch({ body: { ...(fixture("naver-directions5.json") as object), route: { traavoidtoll: (fixture("naver-directions5.json") as any).route.traoptimal } } });
    await naver(stub).route({ origin: A, destination: B, avoid: ["toll"] });
    expect(stub.sent[0]!.url.searchParams.get("option")).toBe("traavoidtoll");
    const none = stubFetch();
    expect((await failure(naver(none).route({ origin: A, destination: B, avoid: ["ferries"] }))).kind).toBe("unsupported");
    expect((await failure(naver(none).route({ origin: A, destination: B, departAt: new Date(NOW.getTime() + 3600_000) }))).kind).toBe("unsupported");
    expect(none.sent).toEqual([]);
  });

  it.each([
    [{ status: 400, body: { code: 2, message: "출발지 또는 도착지가 도로 주변이 아님" } }, "no_route"],
    [{ status: 400, body: { code: 5, message: "1500 km" } }, "no_route"],
    [{ status: 400, body: { error: { errorCode: "100", message: "Bad Request Exception" } } }, "bad_request"],
    [{ status: 401, body: { error: { errorCode: "200", message: "Authentication Failed" } } }, "auth"],
    [{ status: 429, body: { error: { errorCode: "400", message: "Quota Exceeded" } } }, "quota"],
    [{ status: 504, body: { error: { errorCode: "510", message: "Endpoint Timeout" } } }, "upstream"],
    ["timeout", "timeout"],
  ] as const)("maps %j to %s", async (reply, kind) => {
    const stub = stubFetch(reply);
    expect((await failure(naver(stub).route({ origin: A, destination: B }))).kind).toBe(kind);
  });
});

describe("what an adapter keeps from a response", () => {
  const kakao = (stub: ReturnType<typeof stubFetch>) => new KakaoProvider({ restKey: "kakao-key", fetch: stub.fn, now: () => NOW });

  it("strips control and bidi characters and caps each string", async () => {
    const doc = { address_name: "서울\u0000 중구\u202e 세종대로" + "가".repeat(500), x: "126.97", y: "37.56" };
    const [hit] = await kakao(stubFetch({ body: { documents: [doc] } })).geocode("x");
    expect(hit!.label.startsWith("서울 중구 세종대로")).toBe(true);
    expect([...hit!.label]).toHaveLength(PROVIDER_TEXT_MAX);
    expect(hit!.label).not.toMatch(/[\u0000-\u001f\u202e]/);
  });

  it("refuses a body larger than the cap, declared or not", async () => {
    const big = "x".repeat(GEO_MAX_BODY_BYTES + 1);
    const declared = (async () => new Response(big, { headers: { "content-length": String(big.length) } })) as typeof fetch;
    const streamed = (async () =>
      new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } }))) as typeof fetch;
    for (const fetch of [declared, streamed]) {
      const error = await failure(new KakaoProvider({ restKey: "k", fetch, now: () => NOW }).geocode("x"));
      expect(error).toMatchObject({ kind: "upstream", message: expect.stringMatching(/too much/) });
    }
  });
});

describe("the rounding boundary", () => {
  it("hands the provider only points cut to three decimals: reverse, origin and destination", async () => {
    const seen: unknown[] = [];
    const inner = {
      name: "fake" as const,
      geocode: async () => [],
      reverse: async (p: unknown) => (seen.push(p), null),
      route: async (r: unknown) => (seen.push(r), { durationSec: 1, distanceM: 1, traffic: "live" as const, roads: [], steps: [], departAt: "" }),
    };
    const outer = roundingProvider(inner);
    await outer.reverse({ lat: 37.5665432, lon: 126.9784321 });
    await outer.route({ origin: { lat: 37.5665432, lon: 126.9784321 }, destination: { lat: 37.4012345, lon: 127.1098765 } });
    expect(seen).toEqual([
      { lat: 37.567, lon: 126.978 },
      { origin: { lat: 37.567, lon: 126.978 }, destination: { lat: 37.401, lon: 127.11 } },
    ]);
  });
});
