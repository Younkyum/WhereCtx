/**
 * Everything WhereCtx asks a maps provider, for one person at a time.
 *
 * - Which key, the budgets and the record of each call: keys.ts.
 * - What leaves the server: a point rounded to three decimals (about 100 m,
 *   types.ts `roundingProvider`), never while maps are off, and never the
 *   live location at or near home while skipProviderNearHome is on.
 *
 * The background area lookup runs after a reading is stored, outside the
 * ingest path, throttled per person, and from a per-person cache first.
 */

import type { WhereCtxConfig } from "../config.js";
import type { AccessLogStore } from "../activity/accessLogStore.js";
import { authorizePrecise, type PresenceViews } from "../privacy/policy.js";
import type { SettingsStore } from "../privacy/settingsStore.js";
import type { PlacesStore } from "../store/placesStore.js";
import type { PresenceStore } from "../store/presenceStore.js";
import type { SharesStore } from "../sharing/sharesStore.js";
import type { Freshness, Place, UserId } from "../types.js";
import { systemClock, type Clock } from "../util/time.js";
import { AreaRefresher, timerSchedule, type AreaUpdate, type Schedule } from "./area.js";
import type { GeoCacheStore } from "./cacheStore.js";
import type { GeoCredentialsStore, StoredGeoCredential } from "./credentialsStore.js";
import { FakeGeoProvider } from "./fake.js";
import { GeoKeys, type CallResult, type GeoCaller, type GeoStatus, type KeyTestOutcome } from "./keys.js";
import { agentNumbers, agentRoads, freshEnoughToRoute, nearHomePlace, ownerNumbers } from "./eta.js";
import { mainRoads } from "./roads.js";
import {
  type GeocodeCandidate,
  type GeoErrorKind,
  type GeoProviderName,
  type LatLon,
  type RouteAvoid,
  type RouteResult,
} from "./types.js";

export { AREA_REFRESH_MIN_MS, AREA_REFRESH_MOVE_M, type AreaUpdate } from "./area.js";
export { GEO_USER_CALLS_PER_MINUTE, KEY_TEST_POINT, type GeoCaller, type GeoStatus, type KeyTestOutcome } from "./keys.js";

export interface EtaRequest {
  /** A registered place's name, else an address or a place to search for. */
  to: string;
  /** Which search result, numbered from 1, when the search finds several. */
  pick?: number;
  departAt?: Date;
  avoid?: readonly RouteAvoid[];
  /** Ask for the turn-by-turn steps too (get_directions). */
  directions?: boolean;
  /** Why an agent needs the precise route: an address destination or the steps. */
  reason?: string;
}

export interface EtaAnswer {
  destination: { label: string; kind: "place" | "address" };
  /** The route starts at the current location, or, for the owner near home, at the home place. */
  origin: "current_location" | "home";
  /**
   * exact: the provider's numbers and roads (the owner). approximate: minutes
   * in 5-minute steps, whole kilometres, the arrival to 5 minutes and only
   * main roads away from the origin and the destination (agents).
   */
  precision: "exact" | "approximate";
  durationMin: number;
  distanceKm: number;
  /** live: timed on current traffic. predicted: a future departure, on the provider's forecast. */
  traffic: RouteResult["traffic"];
  departAt: string;
  arriveAt: string;
  summary: string[];
  /** Turn-by-turn, for the owner, and for an agent that asked and may read the precise location. */
  steps?: string[];
  /** Why the steps an agent asked for are left out. */
  stepsWithheld?: string;
  tollFare?: number;
  taxiFare?: number;
  provider: GeoProviderName;
  /** How fresh the reading the route starts from is, and how long ago the server heard it. */
  freshness: Freshness;
  originAgeMin: number;
  /** Present only when the caller may see the destination's coordinates. */
  deepLinks?: { kakaoMap: string; naverMap: string };
}

/** A search result as the caller may see it: coordinates only for the owner or a place manager. */
export type CandidateView = Omit<GeocodeCandidate, "lat" | "lon"> & Partial<Pick<GeocodeCandidate, "lat" | "lon">>;

/** What came of an ETA request, each case with what the caller is told. */
export type EtaOutcome =
  /** `precise`: the answer rests on the agent's precise access (an address destination, the steps). */
  | { kind: "ok"; answer: EtaAnswer; precise: boolean }
  | { kind: "hidden" }
  | { kind: "denied"; reason: string }
  | { kind: "no_location" }
  | { kind: "too_old"; freshness: Freshness; originAgeMin: number }
  | { kind: "not_found"; reason: string }
  | { kind: "ambiguous"; candidates: CandidateView[] }
  | { kind: "rate_limited" }
  | { kind: "unconfigured" }
  | { kind: "failed"; error: GeoErrorKind; message: string };

export type SearchOutcome =
  | { kind: "ok"; candidates: GeocodeCandidate[]; provider: GeoProviderName }
  | { kind: "hidden" }
  | { kind: "denied"; reason: string }
  | { kind: "rate_limited" }
  | { kind: "unconfigured" }
  | { kind: "failed"; error: GeoErrorKind; message: string };


export interface GeoServiceDeps {
  config: WhereCtxConfig;
  views: PresenceViews;
  credentials: GeoCredentialsStore;
  cache: GeoCacheStore;
  settings: SettingsStore;
  presence: PresenceStore;
  places: PlacesStore;
  accessLog: AccessLogStore;
  shares: Pick<SharesStore, "showsAreaToAnyone">;
  /** Writes presence city/area under the presence mutex (PresenceService.setArea). */
  setArea: (userId: UserId, update: AreaUpdate) => Promise<void>;
  /** Runs the trailing area lookup; a real timer unless a test replaces it. */
  schedule?: Schedule;
  clock?: Clock;
  /** Replaces the network for the real adapters (tests). */
  fetch?: typeof fetch;
}

/** The `appname` Naver Map asks a calling app to name itself by. */
export const NAVER_APP_NAME = "wherectx";

/** Map links to the destination; the origin is left to the app (the device's own location). */
export function deepLinks(label: string, point: LatLon): EtaAnswer["deepLinks"] {
  const name = encodeURIComponent(label);
  return {
    kakaoMap: `https://map.kakao.com/link/to/${name},${point.lat},${point.lon}`,
    naverMap: `nmap://navigation?dlat=${point.lat}&dlng=${point.lon}&dname=${name}&appname=${NAVER_APP_NAME}`,
  };
}

export class GeoService {
  private readonly clock: Clock;
  private readonly keys: GeoKeys;
  private readonly area: AreaRefresher;
  /** Answers every call when GEO_PROVIDER_FAKE is on. */
  readonly fake?: FakeGeoProvider;

  constructor(private readonly deps: GeoServiceDeps) {
    this.clock = deps.clock ?? systemClock;
    if (deps.config.geo.fake) this.fake = new FakeGeoProvider(this.clock);
    this.keys = new GeoKeys({
      config: deps.config,
      credentials: deps.credentials,
      accessLog: deps.accessLog,
      clock: this.clock,
      fake: this.fake,
      fetch: deps.fetch,
    });
    this.area = new AreaRefresher({
      settings: deps.settings,
      presence: deps.presence,
      places: deps.places,
      shares: deps.shares,
      cache: deps.cache,
      keys: this.keys,
      nearRadiusMultiplier: deps.config.geofence.nearRadiusMultiplier,
      setArea: deps.setArea,
      clock: this.clock,
      schedule: deps.schedule ?? timerSchedule,
    });
  }

  // ---- keys ----

  async status(userId: UserId): Promise<GeoStatus> {
    return this.keys.status(userId, await this.deps.settings.getOrSeed(userId));
  }

  /** Save a provider's keys, replacing those saved for it before. */
  saveCredential(userId: UserId, provider: GeoProviderName, keys: Record<string, string>): Promise<StoredGeoCredential> {
    return this.keys.save(userId, provider, keys);
  }

  deleteCredential(userId: UserId, provider: GeoProviderName): Promise<boolean> {
    return this.keys.delete(userId, provider);
  }

  /** Look up a fixed public landmark with my saved key, never my location. */
  testCredential(userId: UserId, provider: GeoProviderName): Promise<KeyTestOutcome> {
    return this.keys.test(userId, provider);
  }

  // ---- calls ----

  /**
   * Search an address or a place by name. Sends only the text. Needs maps
   * on; an agent also needs manage_places and a presence it may see.
   */
  async search(userId: UserId, query: string, caller: GeoCaller): Promise<SearchOutcome> {
    const settings = await this.deps.settings.getOrSeed(userId);
    if (caller.kind === "agent") {
      if (!caller.scopes.includes("manage_places")) return { kind: "denied", reason: "searching needs the manage_places scope" };
      if (settings.defaultAgentAccess === "hidden") return { kind: "hidden" };
    }
    if (!settings.geoEnabled) return { kind: "denied", reason: "maps are turned off (geoEnabled)" };
    const resolved = await this.keys.resolve(userId, settings);
    if (!resolved) return { kind: "unconfigured" };
    const result = await this.keys.call(userId, caller, resolved, "geo.geocode", (p) => p.geocode(query));
    if (result.kind === "ok") return { kind: "ok", candidates: result.value, provider: resolved.name };
    if (result.kind === "rate_limited") return result;
    return { kind: "failed", error: result.error.kind, message: result.error.message };
  }

  /**
   * Time a car route from where I am to a destination (eta.ts says what each
   * caller is told). Agents need etaToAgents, a visible presence, a
   * registered place as the destination unless they may read the precise
   * location, and are refused at or near home while skipProviderNearHome is
   * on. Everyone needs the maps switch on and a reading fresh enough to start
   * from. The owner near home is timed from the home place.
   */
  async eta(userId: UserId, request: EtaRequest, caller: GeoCaller): Promise<EtaOutcome> {
    const settings = await this.deps.settings.getOrSeed(userId);
    if (caller.kind === "agent") {
      if (settings.defaultAgentAccess === "hidden") return { kind: "hidden" };
      if (!settings.etaToAgents) return { kind: "denied", reason: "ETA for agents is turned off in Maps & routes (etaToAgents)" };
    }
    if (!settings.geoEnabled) return { kind: "denied", reason: "maps are turned off (geoEnabled)" };
    const presence = await this.deps.presence.getCurrent(userId);
    if (!presence?.precise) return { kind: "no_location" };
    const fresh = this.deps.views.freshness(presence);
    const originAgeMin = Math.floor(fresh.lastReportAgoSec / 60);
    if (!freshEnoughToRoute(fresh, presence.status)) return { kind: "too_old", freshness: fresh.freshness, originAgeMin };

    const places = await this.deps.places.list(userId);
    const home = settings.skipProviderNearHome
      ? nearHomePlace(presence.precise, places, this.deps.config.geofence.nearRadiusMultiplier)
      : null;
    const agent = caller.kind === "agent" ? caller : null;
    if (agent && home) return { kind: "denied", reason: "the person is at or near home, and no route is timed from there" };
    const precise =
      agent !== null &&
      authorizePrecise({ scopes: [...agent.scopes], settings, presence, reason: request.reason }).allowed;

    const place = places.find((p: Place) => p.name === request.to);
    if (!place && agent && !precise) {
      return {
        kind: "denied",
        reason:
          "agents may time a route only to a registered place; an address needs precise access (read_precise_location, allowed by the person, and a reason)",
      };
    }
    const resolved = await this.keys.resolve(userId, settings);
    if (!resolved) return { kind: "unconfigured" };

    const managesPlaces = !agent || agent.scopes.includes("manage_places");
    let target: { label: string; kind: "place" | "address"; point: LatLon; showLinks: boolean };
    if (place) {
      target = { label: place.name, kind: "place", point: place, showLinks: managesPlaces };
    } else {
      const search = await this.keys.call(userId, caller, resolved, "geo.geocode", (p) => p.geocode(request.to));
      if (search.kind !== "ok") return failure(search);
      const chosen = pickCandidate(search.value, request.pick);
      if (chosen.kind === "none") return { kind: "not_found", reason: `no place named, and nothing found for, "${request.to}"` };
      if (chosen.kind === "ambiguous") return { kind: "ambiguous", candidates: candidateViews(search.value, managesPlaces) };
      // The caller named this address, so linking to it shows them nothing new.
      target = { label: chosen.candidate.label, kind: "address", point: chosen.candidate, showLinks: true };
    }

    const origin: LatLon = home ?? presence.precise;
    const routed = await this.keys.call(userId, caller, resolved, "geo.route", (p) =>
      p.route({ origin, destination: target.point, departAt: request.departAt, avoid: request.avoid }),
    );
    if (routed.kind !== "ok") return failure(routed);
    const route = routed.value;
    const common = {
      destination: { label: target.label, kind: target.kind },
      origin: home ? ("home" as const) : ("current_location" as const),
      traffic: route.traffic,
      departAt: route.departAt,
      provider: resolved.name,
      freshness: fresh.freshness,
      originAgeMin,
      ...(target.showLinks ? { deepLinks: deepLinks(target.label, target.point) } : {}),
    };
    if (!agent) {
      return {
        kind: "ok",
        precise: false,
        answer: {
          ...common,
          precision: "exact",
          ...ownerNumbers(route),
          summary: mainRoads(route.roads),
          steps: route.steps,
          ...(route.tollFare !== undefined ? { tollFare: route.tollFare } : {}),
          ...(route.taxiFare !== undefined ? { taxiFare: route.taxiFare } : {}),
        },
      };
    }
    const avoid = target.kind === "place" ? [presence.precise, target.point] : [presence.precise];
    const steps = request.directions
      ? precise
        ? { steps: route.steps }
        : { stepsWithheld: "turn-by-turn steps name the streets around the person; they need precise access (read_precise_location, allowed by the person, and a reason)" }
      : {};
    return {
      kind: "ok",
      precise: precise && (target.kind === "address" || request.directions === true),
      answer: { ...common, precision: "approximate", ...agentNumbers(route), summary: agentRoads(route.roads, avoid), ...steps },
    };
  }

  // ---- the background area ----

  /** Bring my area up to date with my current reading, in the background (area.ts). */
  refreshArea(userId: UserId): void {
    this.area.refresh(userId);
  }

  /** Wait for every background lookup started so far (tests, shutdown). */
  settled(): Promise<void> {
    return this.area.settled();
  }

  /** Cancel trailing lookups and wait for running ones (shutdown). */
  close(): Promise<void> {
    return this.area.close();
  }

  prune(): Promise<number> {
    return this.deps.cache.prune();
  }
}

/** A call that did not answer, as an outcome. */
function failure(result: Exclude<CallResult<unknown>, { kind: "ok" }>): Extract<EtaOutcome, { kind: "rate_limited" | "failed" }> {
  return result.kind === "rate_limited" ? result : { kind: "failed", error: result.error.kind, message: result.error.message };
}

type CandidateChoice =
  | { kind: "one"; candidate: GeocodeCandidate }
  | { kind: "ambiguous" }
  | { kind: "none" };

/** The candidate a search settles on: the only one, or the one picked by its 1-based number. */
export function pickCandidate(candidates: readonly GeocodeCandidate[], pick?: number): CandidateChoice {
  if (pick !== undefined) {
    const candidate = candidates[pick - 1];
    return candidate ? { kind: "one", candidate } : { kind: "none" };
  }
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1) return { kind: "one", candidate: candidates[0]! };
  return { kind: "ambiguous" };
}

/** Search results for the caller, numbered for `pick`; coordinates only for those who may see them. */
export function candidateViews(candidates: readonly GeocodeCandidate[], withCoordinates: boolean): CandidateView[] {
  return candidates.map(({ lat, lon, ...rest }) => (withCoordinates ? { ...rest, lat, lon } : rest));
}
