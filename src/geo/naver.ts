/**
 * Naver Cloud Platform Maps: Geocoding, Reverse Geocoding and Directions 5,
 * with an Application's Client ID and Client Secret in
 * `x-ncp-apigw-api-key-id` and `x-ncp-apigw-api-key`.
 *
 * Docs (checked 2026-10-19):
 * - https://api.ncloud-docs.com/docs/application-maps-overview (hosts, headers, gateway errors)
 * - https://api.ncloud-docs.com/docs/application-maps-geocoding
 * - https://api.ncloud-docs.com/docs/application-maps-reversegeocoding
 * - https://api.ncloud-docs.com/docs/application-maps-directions5
 *
 * Directions 5 always uses real-time traffic and takes no departure time, so
 * a future departure is `unsupported`. It routes cars only; Naver Cloud Maps
 * offers no transit, walking or cycling route API (the API list in the
 * overview above), so every other mode is `unsupported`. Geocoding searches addresses only,
 * not place names.
 */

import { z } from "zod";
import { getJson, malformed, providerText } from "./http.js";
import { naverFailure } from "./problems.js";
import {
  GeoError,
  type GeocodeCandidate,
  type GeoProvider,
  type LatLon,
  type ReverseResult,
  type CarRoute,
  type RouteAvoid,
  type RouteRequest,
  type RouteRoad,
} from "./types.js";

export const NAVER_MAPS_BASE = "https://maps.apigw.ntruss.com";

const num = z.union([z.number(), z.string()]).transform(Number).pipe(z.number().finite());

const Geocode = z.object({
  status: z.string(),
  addresses: z.array(
    z.object({
      roadAddress: providerText,
      jibunAddress: providerText,
      x: num,
      y: num,
    }),
  ),
});

const Area = z.object({ name: providerText });
const Reverse = z.object({
  status: z.object({ code: z.number() }),
  results: z
    .array(
      z.object({
        region: z.object({ area1: Area, area2: Area, area3: Area }),
      }),
    )
    .optional(),
});

const RouteBody = z.object({
  summary: z.object({
    distance: z.number(),
    duration: z.number(),
    tollFare: z.number().optional(),
    taxiFare: z.number().optional(),
  }),
  /** Every vertex of the route as [x, y]; a section is a run of it. */
  path: z.array(z.tuple([z.number(), z.number()])).optional(),
  section: z
    .array(z.object({ name: providerText, distance: z.number(), pointIndex: z.number().int(), pointCount: z.number().int() }))
    .optional(),
  guide: z.array(z.object({ type: z.number(), instructions: providerText })).optional(),
});
const Directions = z.object({
  code: z.number(),
  route: z.record(z.string(), z.array(RouteBody)).optional(),
});
const DirectionsFailure = z.object({ code: z.number() });

/** The route option for an `avoid` list. Directions 5 has one option per route and none for ferries. */
function routeOption(avoid: readonly RouteAvoid[] | undefined): string {
  const set = new Set(avoid ?? []);
  if (set.has("ferries")) throw new GeoError("unsupported", "Naver cannot avoid ferries");
  if (set.size > 1) throw new GeoError("unsupported", "Naver avoids one road kind at a time");
  if (set.has("toll")) return "traavoidtoll";
  if (set.has("motorway")) return "traavoidcaronly";
  return "traoptimal";
}

export interface NaverOptions {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

export class NaverProvider implements GeoProvider {
  readonly name = "naver" as const;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: NaverOptions) {
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  private request(path: string, params: Record<string, string>) {
    const url = new URL(path, NAVER_MAPS_BASE);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return getJson(this.fetchFn, url, {
      "x-ncp-apigw-api-key-id": this.options.clientId,
      "x-ncp-apigw-api-key": this.options.clientSecret,
    });
  }

  private failure(status: number, body: unknown) {
    return naverFailure(status, body, [this.options.clientId, this.options.clientSecret]);
  }

  private parse<T>(schema: z.ZodType<T>, body: unknown): T {
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw malformed();
    return parsed.data;
  }

  async geocode(query: string): Promise<GeocodeCandidate[]> {
    const { status, body } = await this.request("/map-geocode/v2/geocode", { query, count: "10" });
    if (status !== 200) throw this.failure(status, body);
    const res = this.parse(Geocode, body);
    if (res.status !== "OK") throw new GeoError("bad_request", "Naver rejected the search");
    return res.addresses.map((a) => ({
      label: a.roadAddress || a.jibunAddress,
      address: a.jibunAddress || a.roadAddress,
      ...(a.roadAddress ? { roadAddress: a.roadAddress } : {}),
      lat: a.y,
      lon: a.x,
      kind: "address" as const,
    }));
  }

  async reverse(point: LatLon): Promise<ReverseResult | null> {
    const { status, body } = await this.request("/map-reversegeocode/v2/gc", {
      coords: `${point.lon},${point.lat}`,
      orders: "admcode",
      output: "json",
    });
    if (status !== 200) throw this.failure(status, body);
    const res = this.parse(Reverse, body);
    if (res.status.code === 3) return null;
    if (res.status.code !== 0) throw new GeoError("upstream", `Naver could not convert the point (code ${res.status.code})`);
    const region = res.results?.[0]?.region;
    if (!region) return null;
    return {
      region1: region.area1.name,
      region2: region.area2.name,
      region3: region.area3.name,
      label: [region.area2.name, region.area3.name].filter(Boolean).join(" "),
    };
  }

  async route(request: RouteRequest): Promise<CarRoute> {
    if (request.mode !== "car") throw new GeoError("unsupported", `Naver routes cars only, not ${request.mode}`);
    if (request.departAt !== undefined && request.departAt.getTime() > this.now().getTime()) {
      throw new GeoError("unsupported", "Naver Directions takes no departure time; it always times the route for now");
    }
    const option = routeOption(request.avoid);
    const { status, body } = await this.request("/map-direction/v1/driving", {
      start: `${request.origin.lon},${request.origin.lat}`,
      goal: `${request.destination.lon},${request.destination.lat}`,
      option,
    });
    if (status === 400) {
      const failure = DirectionsFailure.safeParse(body);
      // Codes 1-5: same start and goal, a point off the road network, no car route, >1500 km.
      if (failure.success && failure.data.code >= 1 && failure.data.code <= 5) {
        throw new GeoError("no_route", `Naver found no route (code ${failure.data.code})`);
      }
    }
    if (status !== 200) throw this.failure(status, body);
    const res = this.parse(Directions, body);
    const route = res.route?.[option]?.[0];
    if (res.code !== 0 || !route) throw new GeoError("no_route", `Naver found no route (code ${res.code})`);
    return {
      mode: "car",
      durationSec: Math.round(route.summary.duration / 1000),
      distanceM: route.summary.distance,
      traffic: "live",
      ...(route.summary.tollFare !== undefined ? { tollFare: route.summary.tollFare } : {}),
      ...(route.summary.taxiFare !== undefined ? { taxiFare: route.summary.taxiFare } : {}),
      roads: (route.section ?? []).map(
        (s): RouteRoad => ({
          name: s.name,
          distanceM: s.distance,
          path: (route.path ?? []).slice(s.pointIndex, s.pointIndex + s.pointCount).map(([lon, lat]) => ({ lat, lon })),
        }),
      ),
      path: (route.path ?? []).map(([lon, lat]) => ({ lat, lon })),
      // 87 and 88 mark a waypoint and the destination, not a turn.
      steps: (route.guide ?? []).filter((g) => g.type !== 87 && g.type !== 88).map((g) => g.instructions).slice(0, 30),
      departAt: this.now().toISOString(),
    };
  }
}
