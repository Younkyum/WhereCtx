/**
 * Kakao: Local API for geocoding and region names, Kakao Mobility Directions
 * for car routes. Both take the same REST API key as
 * `Authorization: KakaoAK <key>`.
 *
 * Docs (checked 2026-10-19):
 * - https://developers.kakao.com/docs/ko/local/dev-guide
 * - https://developers.kakaomobility.com/guide/navi-api/directions.html
 * - https://developers.kakaomobility.com/guide/navi-api/future.html
 * - https://developers.kakaomobility.com/guide/navi-api/reference.html (result_code)
 * - https://developers.kakaomobility.com/guide/navi-api/solution.html (error codes)
 */

import { z } from "zod";
import { errorForStatus, getJson, malformed, providerText } from "./http.js";
import {
  GeoError,
  type GeocodeCandidate,
  type GeoProvider,
  type LatLon,
  type ReverseResult,
  type RouteRequest,
  type RouteResult,
  type RouteRoad,
} from "./types.js";

export const KAKAO_LOCAL_BASE = "https://dapi.kakao.com";
export const KAKAO_NAVI_BASE = "https://apis-navi.kakaomobility.com";

const num = z.union([z.number(), z.string()]).transform(Number).pipe(z.number().finite());

const AddressDoc = z.object({
  address_name: providerText,
  x: num,
  y: num,
  address: z.object({ address_name: providerText }).nullish(),
  road_address: z.object({ address_name: providerText }).nullish(),
});
const AddressSearch = z.object({ documents: z.array(AddressDoc) });

const KeywordDoc = z.object({
  place_name: providerText,
  address_name: providerText,
  road_address_name: providerText.optional(),
  x: num,
  y: num,
});
const KeywordSearch = z.object({ documents: z.array(KeywordDoc) });

const RegionDoc = z.object({
  region_type: z.string(),
  region_1depth_name: providerText,
  region_2depth_name: providerText,
  region_3depth_name: providerText,
});
const RegionCode = z.object({ documents: z.array(RegionDoc) });

const Directions = z.object({
  routes: z
    .array(
      z.object({
        result_code: z.number(),
        result_msg: z.string(),
        summary: z
          .object({
            fare: z.object({ taxi: z.number(), toll: z.number() }),
            distance: z.number(),
            duration: z.number(),
          })
          .optional(),
        sections: z
          .array(
            z.object({
              roads: z
                .array(z.object({ name: providerText, distance: z.number(), vertexes: z.array(z.number()).optional() }))
                .optional(),
              guides: z.array(z.object({ name: providerText, guidance: providerText, type: z.number() })).optional(),
            }),
          )
          .optional(),
      }),
    )
    .min(1),
});

/** Kakao's error body: `{ code, msg }` (navi) or `{ errorType, message }` (local). */
const ErrorBody = z.object({ code: z.number() }).partial();

/** Guide types that mark the start, the end and a waypoint rather than a turn. */
const ENDPOINT_GUIDES = new Set([100, 101, 1000]);

/** Roads' paths end to end, without the point where one road meets the next twice. */
function joined(paths: readonly LatLon[][]): LatLon[] {
  const path: LatLon[] = [];
  for (const point of paths.flat()) {
    const last = path.at(-1);
    if (!last || last.lat !== point.lat || last.lon !== point.lon) path.push(point);
  }
  return path;
}

/** A road's `vertexes`, flat [x1, y1, x2, y2, ...], as points. */
function vertexPath(vertexes: readonly number[] | undefined): LatLon[] {
  const path: LatLon[] = [];
  for (let i = 0; vertexes && i + 1 < vertexes.length; i += 2) path.push({ lat: vertexes[i + 1]!, lon: vertexes[i]! });
  return path;
}

/** `departure_time`, YYYYMMDDHHMM. The docs give no time zone; Kakao serves Korea, so it is read as KST. */
export function kakaoDepartureTime(at: Date): string {
  const kst = new Date(at.getTime() + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${kst.getUTCFullYear()}${p(kst.getUTCMonth() + 1)}${p(kst.getUTCDate())}${p(kst.getUTCHours())}${p(kst.getUTCMinutes())}`;
}

export interface KakaoOptions {
  restKey: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

export class KakaoProvider implements GeoProvider {
  readonly name = "kakao" as const;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: KakaoOptions) {
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  private async get<T>(base: string, path: string, params: Record<string, string>, schema: z.ZodType<T>): Promise<T> {
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const { status, body } = await getJson(this.fetchFn, url, { Authorization: `KakaoAK ${this.options.restKey}` });
    if (status < 200 || status >= 300) {
      if (ErrorBody.safeParse(body).data?.code === -10) throw new GeoError("quota", "the Kakao quota was reached");
      throw errorForStatus(status);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw malformed();
    return parsed.data;
  }

  async geocode(query: string): Promise<GeocodeCandidate[]> {
    const byAddress = await this.get(KAKAO_LOCAL_BASE, "/v2/local/search/address.json", { query, size: "10" }, AddressSearch);
    if (byAddress.documents.length > 0) {
      return byAddress.documents.map((d) => ({
        label: d.road_address?.address_name ?? d.address_name,
        address: d.address?.address_name ?? d.address_name,
        ...(d.road_address ? { roadAddress: d.road_address.address_name } : {}),
        lat: d.y,
        lon: d.x,
        kind: "address" as const,
      }));
    }
    const byKeyword = await this.get(KAKAO_LOCAL_BASE, "/v2/local/search/keyword.json", { query, size: "10" }, KeywordSearch);
    return byKeyword.documents.map((d) => ({
      label: d.place_name,
      address: d.address_name,
      ...(d.road_address_name ? { roadAddress: d.road_address_name } : {}),
      lat: d.y,
      lon: d.x,
      kind: "place" as const,
    }));
  }

  async reverse(point: LatLon): Promise<ReverseResult | null> {
    const res = await this.get(
      KAKAO_LOCAL_BASE,
      "/v2/local/geo/coord2regioncode.json",
      { x: String(point.lon), y: String(point.lat) },
      RegionCode,
    );
    // H is the administrative dong people name; B (legal dong) when there is no H.
    const doc = res.documents.find((d) => d.region_type === "H") ?? res.documents[0];
    if (!doc) return null;
    return {
      region1: doc.region_1depth_name,
      region2: doc.region_2depth_name,
      region3: doc.region_3depth_name,
      label: [doc.region_2depth_name, doc.region_3depth_name].filter(Boolean).join(" "),
    };
  }

  async route(request: RouteRequest): Promise<RouteResult> {
    const future = request.departAt !== undefined && request.departAt.getTime() > this.now().getTime();
    const params: Record<string, string> = {
      origin: `${request.origin.lon},${request.origin.lat}`,
      destination: `${request.destination.lon},${request.destination.lat}`,
      priority: "RECOMMEND",
      summary: "false",
    };
    if (request.avoid?.length) params.avoid = request.avoid.join("|");
    if (future) params.departure_time = kakaoDepartureTime(request.departAt!);
    const res = await this.get(KAKAO_NAVI_BASE, future ? "/v1/future/directions" : "/v1/directions", params, Directions);
    const route = res.routes[0]!;
    if (route.result_code !== 0 || !route.summary) {
      throw new GeoError("no_route", `Kakao found no route (result_code ${route.result_code})`);
    }
    const sections = route.sections ?? [];
    return {
      durationSec: route.summary.duration,
      distanceM: route.summary.distance,
      traffic: future ? "predicted" : "live",
      tollFare: route.summary.fare.toll,
      taxiFare: route.summary.fare.taxi,
      roads: sections.flatMap((s) =>
        (s.roads ?? []).map((r): RouteRoad => ({ name: r.name, distanceM: r.distance, path: vertexPath(r.vertexes) })),
      ),
      path: joined(sections.flatMap((s) => (s.roads ?? []).map((r) => vertexPath(r.vertexes)))),
      steps: sections
        .flatMap((s) => s.guides ?? [])
        .filter((g) => !ENDPOINT_GUIDES.has(g.type))
        .map((g) => [g.name, g.guidance].filter(Boolean).join(" "))
        .slice(0, 30),
      departAt: (future ? request.departAt! : this.now()).toISOString(),
    };
  }
}
