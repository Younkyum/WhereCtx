/**
 * Maps providers (Kakao, Naver) behind one interface: geocoding, reverse
 * geocoding to region names, and car routes. Each adapter parses its
 * provider's response with zod at the boundary and maps failures to a
 * `GeoError` kind, so callers never see a provider's wire format or a raw
 * HTTP error.
 */

export const GEO_PROVIDERS = ["kakao", "naver"] as const;
export type GeoProviderName = (typeof GEO_PROVIDERS)[number];

export interface LatLon {
  lat: number;
  lon: number;
}

export interface GeocodeCandidate {
  /** A place name (keyword search) or the address itself. */
  label: string;
  address: string;
  roadAddress?: string;
  lat: number;
  lon: number;
  kind: "address" | "place";
}

/** Region names only: never a house or building number. */
export interface ReverseResult {
  /** 시/도 */
  region1: string;
  /** 시/군/구 */
  region2: string;
  /** 읍/면/동 */
  region3: string;
  /** "<region2> <region3>", the neighbourhood as people say it. */
  label: string;
}

export const ROUTE_AVOID = ["toll", "motorway", "ferries"] as const;
export type RouteAvoid = (typeof ROUTE_AVOID)[number];

export interface RouteRequest {
  origin: LatLon;
  destination: LatLon;
  /** A future departure; omitted means now. */
  departAt?: Date;
  avoid?: readonly RouteAvoid[];
}

/**
 * live: the provider used current traffic. predicted: a future departure,
 * timed on the provider's forecast.
 */
export type TrafficBasis = "live" | "predicted";

/** One named stretch of a route and where it runs; `path` is empty when the provider gave no geometry for it. */
export interface RouteRoad {
  name: string;
  distanceM: number;
  path: LatLon[];
}

export interface RouteResult {
  durationSec: number;
  distanceM: number;
  traffic: TrafficBasis;
  tollFare?: number;
  taxiFare?: number;
  /** Every named stretch in order, with its geometry, so a caller can tell which roads run near a point. */
  roads: RouteRoad[];
  /** The whole route as the provider drew it, start to end, named stretch or not. */
  path: LatLon[];
  /** Turn-by-turn instructions in order, when the provider gives them. */
  steps: string[];
  departAt: string;
}

export interface GeoProvider {
  readonly name: GeoProviderName | "fake";
  geocode(query: string): Promise<GeocodeCandidate[]>;
  /** Null when the point has no address (at sea, outside Korea). */
  reverse(point: LatLon): Promise<ReverseResult | null>;
  route(request: RouteRequest): Promise<RouteResult>;
}

/**
 * auth: the key was refused. quota: a quota or rate limit was hit.
 * no_route: the provider found no route between the points.
 * unsupported: this provider cannot answer this request (a future departure on Naver).
 * bad_request: the provider rejected the request's parameters.
 * timeout, upstream: the provider did not answer, or failed.
 */
export const GEO_ERROR_KINDS = ["auth", "quota", "no_route", "unsupported", "bad_request", "timeout", "upstream"] as const;
export type GeoErrorKind = (typeof GEO_ERROR_KINDS)[number];

/** A provider failure. The message never holds coordinates or a key. */
export class GeoError extends Error {
  constructor(
    readonly kind: GeoErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "GeoError";
  }
}

/** The credential a provider's REST calls take. */
export type GeoCredentials =
  | { provider: "kakao"; restKey: string }
  | { provider: "naver"; clientId: string; clientSecret: string };

/**
 * Every key kind a person may hold per provider: the REST kinds the server
 * calls with, and the map kind a browser loads the provider's map with (a
 * Kakao JavaScript key, a Naver Maps key id; mapSdk.ts). The whole bag is
 * sealed as one JSON value.
 */
export const GEO_KEY_KINDS = {
  kakao: ["restKey", "jsKey"],
  naver: ["clientId", "clientSecret", "mapKeyId"],
} as const satisfies Record<GeoProviderName, readonly string[]>;
export type GeoKeyKind<P extends GeoProviderName> = (typeof GEO_KEY_KINDS)[P][number];
/** A provider's keys by kind; any may be absent. */
export type GeoKeyBag = Partial<Record<string, string>>;

/** The REST credential in a key bag, when it holds every kind the REST calls need. */
export function restCredentials(provider: GeoProviderName, keys: GeoKeyBag): GeoCredentials | null {
  if (provider === "kakao") return keys.restKey ? { provider, restKey: keys.restKey } : null;
  return keys.clientId && keys.clientSecret
    ? { provider, clientId: keys.clientId, clientSecret: keys.clientSecret }
    : null;
}

/** Which kinds of a bag the dashboard names, by their last four characters; secrets are never hinted. */
export const HINTED_KINDS: ReadonlySet<string> = new Set(["restKey", "clientId", "jsKey", "mapKeyId"]);

/** About 100 m: the precision a coordinate is cut to before it leaves the server. */
export const OUTBOUND_DECIMALS = 3;

export function roundCoord(value: number, decimals = OUTBOUND_DECIMALS): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

export function roundPoint(point: LatLon): LatLon {
  return { lat: roundCoord(point.lat), lon: roundCoord(point.lon) };
}

/**
 * The only way a provider is reached: every point it is handed (a reverse
 * lookup, a route's origin and destination) is cut to OUTBOUND_DECIMALS
 * first, whoever the caller is.
 */
export function roundingProvider(inner: GeoProvider): GeoProvider {
  return {
    name: inner.name,
    geocode: (query) => inner.geocode(query),
    reverse: (point) => inner.reverse(roundPoint(point)),
    route: (request) => inner.route({ ...request, origin: roundPoint(request.origin), destination: roundPoint(request.destination) }),
  };
}
