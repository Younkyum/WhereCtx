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
import { MAP_SDKS, type MapConfig } from "./mapSdk.js";
import { mainRoads } from "./roads.js";
import {
  type GeocodeCandidate,
  type GeoErrorKind,
  type GeoProviderName,
  type LatLon,
  type RouteAvoid,
  type RouteResult,
} from "./types.js";


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

interface EtaCommon {
  destination: { label: string; kind: "place" | "address" };
  /** The route starts at the current location, or, for the owner near home, at the home place. */
  origin: "current_location" | "home";
  durationMin: number;
  distanceKm: number;
  /** live: timed on current traffic. predicted: a future departure, on the provider's forecast. */
  traffic: RouteResult["traffic"];
  departAt: string;
  arriveAt: string;
  summary: string[];
  provider: GeoProviderName;
  /** How fresh the reading the route starts from is, and how long ago the server heard it. */
  freshness: Freshness;
  originAgeMin: number;
  /** Present only when the caller may see the destination's coordinates. */
  deepLinks?: { kakaoMap: string; naverMap: string };
}

/** The owner's answer: the provider's numbers and roads, the steps, the fares, and the route as drawn. */
export interface OwnerEtaAnswer extends EtaCommon {
  precision: "exact";
  /** The whole route as the provider drew it, start to end. */
  path: LatLon[];
  steps: string[];
  tollFare?: number;
  taxiFare?: number;
}

/**
 * An agent's answer: minutes in 5-minute steps, whole kilometres, the
 * arrival to 5 minutes and only main roads away from the origin and the
 * destination. It never carries the route's geometry.
 */
export interface AgentEtaAnswer extends EtaCommon {
  precision: "approximate";
  path?: never;
  /** Turn-by-turn, for an agent that asked and may read the precise location. */
  steps?: string[];
  /** Why the steps an agent asked for are left out. */
  stepsWithheld?: string;
}

export type EtaAnswer = OwnerEtaAnswer | AgentEtaAnswer;

/** A search result as the caller may see it: coordinates only for the owner or a place manager. */
export type CandidateView = Omit<GeocodeCandidate, "lat" | "lon"> & Partial<Pick<GeocodeCandidate, "lat" | "lon">>;

/** What came of an ETA request, each case with what the caller is told. */
export type EtaOutcome<A extends EtaAnswer = EtaAnswer> =
  /** `precise`: the answer rests on the agent's precise access (an address destination, the steps). */
  | { kind: "ok"; answer: A; precise: boolean }
  | { kind: "hidden" }
  | { kind: "denied"; reason: string }
  | { kind: "no_location" }
  | { kind: "too_old"; freshness: Freshness; originAgeMin: number }
  | { kind: "not_found"; reason: string }
  | { kind: "ambiguous"; candidates: CandidateView[] }
  | { kind: "rate_limited" }
  | { kind: "unconfigured" }
  | { kind: "failed"; error: GeoErrorKind; message: string };

/** Every way an ETA request ends without an answer. */
type EtaRefusal = Exclude<EtaOutcome, { kind: "ok" }>;

/** A route timed from where the person is, before it is shaped for whoever asked. */
interface TimedRoute {
  route: RouteResult;
  common: Omit<EtaCommon, "durationMin" | "distanceKm" | "arriveAt" | "summary">;
  /** Whether an agent's request may read the precise location (always false for the owner). */
  precise: boolean;
  /** Points whose roads an agent is not told about: the start, and a registered destination. */
  avoid: LatLon[];
}

export type AgentCaller = Extract<GeoCaller, { kind: "agent" }>;

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

  /** Save, or with null forget, my map key for a provider (mapSdk.ts). */
  saveMapKey(userId: UserId, provider: GeoProviderName, key: string | null): Promise<StoredGeoCredential | null> {
    return this.keys.saveMapKey(userId, provider, key);
  }

  /**
   * The map my dashboard loads: the provider's script with my map key, or
   * none while maps are off or no map key is set up. Only ever sent to my own
   * signed-in session, which hands the key to the provider to draw tiles.
   */
  async mapConfig(userId: UserId): Promise<MapConfig> {
    const settings = await this.deps.settings.getOrSeed(userId);
    const map = settings.geoEnabled ? await this.keys.resolveMap(userId, settings) : null;
    return map ? { provider: map.provider, sdkUrl: MAP_SDKS[map.provider].sdkUrl(map.key) } : { provider: null };
  }

  /** Forget a provider's REST keys (keeping its map key), and every area answer kept for me. */
  async deleteCredential(userId: UserId, provider: GeoProviderName): Promise<boolean> {
    const deleted = await this.keys.deleteRest(userId, provider);
    if (deleted) await this.deps.cache.purge(userId);
    return deleted;
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
   * Time a car route from where I am to a destination, for an agent (eta.ts
   * says what it is told). Agents need etaToAgents, a visible presence, a
   * registered place as the destination unless they may read the precise
   * location, and are refused at or near home while skipProviderNearHome is
   * on. The answer never carries the route's geometry.
   */
  async eta(userId: UserId, request: EtaRequest, caller: AgentCaller): Promise<EtaOutcome<AgentEtaAnswer>> {
    const timed = await this.timeRoute(userId, request, caller);
    if ("kind" in timed) return timed;
    const { route, common, precise, avoid } = timed;
    const steps = request.directions
      ? precise
        ? { steps: route.steps }
        : { stepsWithheld: "turn-by-turn steps name the streets around the person; they need precise access (read_precise_location, allowed by the person, and a reason)" }
      : {};
    return {
      kind: "ok",
      precise: precise && (common.destination.kind === "address" || request.directions === true),
      answer: { ...common, precision: "approximate", ...agentNumbers(route), summary: agentRoads(route.roads, avoid), ...steps },
    };
  }

  /** Time a car route for me in the dashboard: the provider's numbers, the steps, and the route as drawn. Near home it starts at the home place. */
  async ownerEta(userId: UserId, request: EtaRequest): Promise<EtaOutcome<OwnerEtaAnswer>> {
    const timed = await this.timeRoute(userId, request, { kind: "owner" });
    if ("kind" in timed) return timed;
    const { route, common } = timed;
    return {
      kind: "ok",
      precise: false,
      answer: {
        ...common,
        precision: "exact",
        ...ownerNumbers(route),
        summary: mainRoads(route.roads),
        path: route.path,
        steps: route.steps,
        ...(route.tollFare !== undefined ? { tollFare: route.tollFare } : {}),
        ...(route.taxiFare !== undefined ? { taxiFare: route.taxiFare } : {}),
      },
    };
  }

  /** Everything an ETA needs before it is shaped: the gates, the destination, and the provider's route. */
  private async timeRoute(userId: UserId, request: EtaRequest, caller: AgentCaller | { kind: "owner" }): Promise<TimedRoute | EtaRefusal> {
    const settings = await this.deps.settings.getOrSeed(userId);
    const agent = caller.kind === "agent" ? caller : null;
    if (agent) {
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
    return {
      route,
      precise,
      avoid: target.kind === "place" ? [presence.precise, target.point] : [presence.precise],
      common: {
        destination: { label: target.label, kind: target.kind },
        origin: home ? "home" : "current_location",
        traffic: route.traffic,
        departAt: route.departAt,
        provider: resolved.name,
        freshness: fresh.freshness,
        originAgeMin,
        ...(target.showLinks ? { deepLinks: deepLinks(target.label, target.point) } : {}),
      },
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
