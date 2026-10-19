/**
 * A provider that answers from a fixed table and plain arithmetic, for tests
 * and for the HTTP end-to-end run (`GEO_PROVIDER_FAKE=1`, refused outside
 * NODE_ENV test or development). It keeps every call so a test can check
 * what would have left the server.
 */

import { haversineMeters } from "../geofence/distance.js";
import {
  GeoError,
  type GeocodeCandidate,
  type GeoProvider,
  type LatLon,
  type ReverseResult,
  type RouteRequest,
  type RouteResult,
} from "./types.js";

export type FakeCall =
  | { op: "geocode"; query: string }
  | { op: "reverse"; point: LatLon }
  | { op: "route"; request: RouteRequest };

const PLACES: Record<string, GeocodeCandidate[]> = {
  "서울특별시청": [
    { label: "서울특별시청", address: "서울 중구 태평로1가 31", roadAddress: "서울 중구 세종대로 110", lat: 37.5663, lon: 126.9779, kind: "place" },
  ],
  "강남역": [
    { label: "강남역 2호선", address: "서울 강남구 역삼동 858", roadAddress: "서울 강남구 강남대로 396", lat: 37.4979, lon: 127.0276, kind: "place" },
  ],
  "판교역": [
    { label: "판교역 신분당선", address: "경기 성남시 분당구 백현동 534", roadAddress: "경기 성남시 분당구 판교역로 160", lat: 37.3948, lon: 127.1112, kind: "place" },
    { label: "판교역 경강선", address: "경기 성남시 분당구 백현동 535", lat: 37.3951, lon: 127.1109, kind: "place" },
  ],
};

/** A region per 0.01-degree cell, so moving about a kilometre changes the dong. */
function regionFor(point: LatLon): ReverseResult {
  const cell = `${Math.floor(point.lat * 100)}-${Math.floor(point.lon * 100)}`;
  const dong = `테스트${(Number.parseInt(cell.replace("-", ""), 10) % 97) + 1}동`;
  return { region1: "서울특별시", region2: "테스트구", region3: dong, label: `테스트구 ${dong}` };
}

/** The point `t` of the way from `a` to `b`. */
const along = (a: LatLon, b: LatLon, t: number): LatLon => ({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });

export class FakeGeoProvider implements GeoProvider {
  readonly name = "fake" as const;
  readonly calls: FakeCall[] = [];
  /** Set to make every call fail with this kind. */
  failWith?: GeoError["kind"];

  constructor(private readonly now: () => Date = () => new Date()) {}

  private check(): void {
    if (this.failWith) throw new GeoError(this.failWith, `fake provider failure: ${this.failWith}`);
  }

  async geocode(query: string): Promise<GeocodeCandidate[]> {
    this.calls.push({ op: "geocode", query });
    this.check();
    return PLACES[query.trim()] ?? [];
  }

  async reverse(point: LatLon): Promise<ReverseResult | null> {
    this.calls.push({ op: "reverse", point });
    this.check();
    return regionFor(point);
  }

  async route(request: RouteRequest): Promise<RouteResult> {
    this.calls.push({ op: "route", request });
    this.check();
    const { origin, destination } = request;
    const straight = haversineMeters(origin.lat, origin.lon, destination.lat, destination.lon);
    if (straight < 5) throw new GeoError("no_route", "origin and destination are the same point");
    const distanceM = Math.round(straight * 1.3);
    const future = request.departAt !== undefined && request.departAt.getTime() > this.now().getTime();
    return {
      // 30 km/h through town.
      durationSec: Math.round(distanceM / (30_000 / 3600)),
      distanceM,
      traffic: future ? "predicted" : "live",
      tollFare: 0,
      taxiFare: 4800 + Math.round(distanceM / 131) * 100,
      // The first stretch and turn name the street the route starts on, as a real provider's do.
      roads: [
        { name: "테스트출발로12번길", distanceM: Math.round(distanceM * 0.1), path: [origin] },
        { name: "테스트대로", distanceM: Math.round(distanceM * 0.6), path: [along(origin, destination, 0.5)] },
        { name: "테스트도착로", distanceM: Math.round(distanceM * 0.3), path: [along(origin, destination, 0.99)] },
      ],
      path: [origin, along(origin, destination, 0.5), destination],
      steps: ["테스트출발로12번길에서 테스트대로 방면으로 우회전", "테스트도착로 진입"],
      departAt: (future ? request.departAt! : this.now()).toISOString(),
    };
  }
}
