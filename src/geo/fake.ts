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
  type ActiveRoute,
  type CarRoute,
  type ReverseResult,
  type RouteRequest,
  type RouteResult,
  type TransitLeg,
  type TransitRoute,
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
    const future = request.departAt !== undefined && request.departAt.getTime() > this.now().getTime();
    if (request.mode !== "car" && (future || request.avoid?.length)) {
      throw new GeoError("unsupported", `${request.mode} routes take no departure time and no roads to avoid`);
    }
    const distanceM = Math.round(straight * 1.3);
    switch (request.mode) {
      case "car":
        return this.drive(request, distanceM, future);
      case "transit":
        return this.transit(request, distanceM);
      case "walk":
      case "bike":
        return this.active(request, request.mode, distanceM);
    }
  }

  private drive({ origin, destination, departAt }: RouteRequest, distanceM: number, future: boolean): CarRoute {
    return {
      mode: "car",
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
      departAt: (future ? departAt! : this.now()).toISOString(),
    };
  }

  /**
   * A walk to a village bus beside the origin, the subway through the
   * middle, a trunk bus to beside the destination, and a walk: the first
   * and last rides board and alight near the ends, as a real trip's do.
   */
  private transit({ origin, destination }: RouteRequest, distanceM: number): TransitRoute {
    const at = (t: number) => along(origin, destination, t);
    const leg = (kind: TransitLeg["kind"], from: number, to: number, lines: string[], stops: string[]): TransitLeg => {
      const d = Math.round(distanceM * (to - from));
      // 4.8 km/h on foot, 25 km/h riding.
      const durationSec = Math.round(d / ((kind === "walk" ? 4800 : 25_000) / 3600));
      const guidance = kind === "walk" ? `${d}m 걷기` : `${lines[0]} (${stops[0]} > ${stops.at(-1)})`;
      return { kind, durationSec, distanceM: d, lines, stops, guidance, path: [at(from), at((from + to) / 2), at(to)] };
    };
    const legs = [
      leg("walk", 0, 0.03, [], []),
      leg("bus", 0.03, 0.3, ["마을 테스트1"], ["테스트출발정류장", "테스트환승정류장"]),
      leg("subway", 0.35, 0.65, ["2호선"], ["테스트환승역", "테스트중간역", "테스트도착역"]),
      leg("bus", 0.7, 0.97, ["간선 472"], ["테스트도착역앞", "테스트도착정류장"]),
      leg("walk", 0.97, 1, [], []),
    ];
    return {
      mode: "transit",
      durationSec: legs.reduce((sum, l) => sum + l.durationSec, 0),
      distanceM,
      transfers: 2,
      fare: 1550,
      legs,
      path: legs.flatMap((l) => l.path),
      departAt: this.now().toISOString(),
    };
  }

  private active({ origin, destination }: RouteRequest, mode: "walk" | "bike", distanceM: number): ActiveRoute {
    const at = (t: number) => along(origin, destination, t);
    return {
      mode,
      // 4.8 km/h walking, 15 km/h cycling.
      durationSec: Math.round(distanceM / ((mode === "walk" ? 4800 : 15_000) / 3600)),
      distanceM,
      steps: [
        { guidance: "테스트출발로12번길 따라 이동", distanceM: Math.round(distanceM * 0.1), path: [origin, at(0.1)] },
        { guidance: "테스트대로 따라 이동", distanceM: Math.round(distanceM * 0.8), path: [at(0.1), at(0.9)] },
        { guidance: "테스트도착로 진입", distanceM: Math.round(distanceM * 0.1), path: [at(0.9), destination] },
      ],
      path: [origin, at(0.1), at(0.9), destination],
      departAt: this.now().toISOString(),
    };
  }
}
