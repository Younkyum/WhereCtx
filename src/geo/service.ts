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
import type { Freshness, Place, PrivacySettings, UserId } from "../types.js";
import { systemClock, type Clock } from "../util/time.js";
import { AreaRefresher, timerSchedule, type AreaUpdate, type Schedule } from "./area.js";
import type { GeoCacheStore } from "./cacheStore.js";
import type { GeoCredentialsStore, StoredGeoCredential } from "./credentialsStore.js";
import { FakeGeoProvider } from "./fake.js";
import { GeoKeys, type CallResult, type GeoCallAction, type GeoCaller, type GeoStatus, type KeyTestOutcome } from "./keys.js";
import { AnswerCache } from "./answerCache.js";
import { AGENT_TIME_STEP_MIN, agentDetail, agentNumbers, freshEnoughToRoute, ownerDetail, ownerNumbers, type OwnerLeg } from "./eta.js";
import { nearHomePlace } from "../geofence/shape.js";
import { keepouts, type Keepout } from "./clearance.js";
import {
  PROVIDER_ROUTE_MODES,
  type GeocodeCandidate,
  type GeoErrorKind,
  type GeoCredentials,
  type GeoProviderName,
  type LatLon,
  type RouteAvoid,
  type RouteMode,
  type RouteResult,
  type TrafficBasis,
} from "./types.js";


export interface EtaRequest {
  mode: RouteMode;
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
  mode: RouteMode;
  destination: { label: string; kind: "place" | "address" };
  /** The route starts at the current location, or, for the owner near home, at the home place. */
  origin: "current_location" | "home";
  durationMin: number;
  distanceKm: number;
  /** Driving only. live: timed on current traffic. predicted: a future departure, on the provider's forecast. */
  traffic?: TrafficBasis;
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

/** The owner's answer: the provider's numbers and roads or lines, the steps, the fares, and the route as drawn. */
export interface OwnerEtaAnswer extends EtaCommon {
  precision: "exact";
  /** The whole route as the provider drew it, start to end. */
  path: LatLon[];
  steps: string[];
  tollFare?: number;
  taxiFare?: number;
  /** Transit: the fare, the transfers, the minutes on foot, and each leg with its stops and geometry. */
  fare?: number;
  transfers?: number;
  walkMin?: number;
  legs?: OwnerLeg[];
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
  /** Transit: how many transfers, and the minutes on foot in 5-minute steps. */
  transfers?: number;
  walkMin?: number;
  legs?: never;
  fare?: never;
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
  /** The provider in use does not route this mode; nothing was sent. `switchTo`: other providers with a key that do. */
  | { kind: "unsupported_mode"; mode: RouteMode; provider: GeoProviderName; supported: readonly RouteMode[]; switchTo: GeoProviderName[] }
  /** An option only driving takes (a later departure, road kinds to avoid); refused before anything was asked or spent. */
  | { kind: "unsupported_option"; mode: Exclude<RouteMode, "car">; option: "departAt" | "avoid" }
  | { kind: "failed"; error: GeoErrorKind; message: string };

/** Every way an ETA request ends without an answer. */
type EtaRefusal = Exclude<EtaOutcome, { kind: "ok" }>;

/** What the gates found: who may hear what, where the person is, and the destination when it is a registered place. */
interface Gated {
  settings: PrivacySettings;
  start: LatLon;
  freshness: Freshness;
  originAgeMin: number;
  places: Place[];
  /** The home place the person is at or near, when routes start there (the owner only). */
  home: Place | null;
  precise: boolean;
  place: Place | null;
}

type AgentEtaOk = Extract<EtaOutcome<AgentEtaAnswer>, { kind: "ok" }>;

/** A later departure or road kinds to avoid on a mode that is not driving, as a refusal. */
function drivingOnlyOption(request: EtaRequest, now: Date): Extract<EtaOutcome, { kind: "unsupported_option" }> | null {
  if (request.mode === "car") return null;
  if (request.departAt && request.departAt.getTime() > now.getTime()) return { kind: "unsupported_option", mode: request.mode, option: "departAt" };
  if (request.avoid?.length) return { kind: "unsupported_option", mode: request.mode, option: "avoid" };
  return null;
}

/** One credential's identical request: the same answer within AGENT_ANSWER_TTL_MS. */
function answerKey(userId: UserId, caller: AgentCaller, request: EtaRequest, precise: boolean): string {
  const stepMs = AGENT_TIME_STEP_MIN * 60_000;
  return JSON.stringify([
    userId,
    caller.credential.kind,
    caller.credential.id,
    request.mode,
    request.to.trim(),
    request.pick ?? null,
    request.directions === true,
    request.departAt ? Math.floor(request.departAt.getTime() / stepMs) : null,
    [...(request.avoid ?? [])].sort(),
    precise,
  ]);
}

/** A route timed from where the person is, before it is shaped for whoever asked. */
interface TimedRoute {
  route: RouteResult;
  common: Omit<EtaCommon, "durationMin" | "distanceKm" | "arriveAt" | "summary">;
  /** Whether an agent's request may read the precise location (always false for the owner). */
  precise: boolean;
  /** What an agent's roads and lines keep clear of: the start, the destination, and every registered place as drawn. */
  avoid: Keepout[];
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
  private readonly agentAnswers = new AnswerCache<AgentEtaOk>();
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
  saveCredential(userId: UserId, credentials: GeoCredentials): Promise<StoredGeoCredential> {
    return this.keys.save(userId, credentials);
  }

  /** Forget a provider's keys, and every area answer kept for me. */
  async deleteCredential(userId: UserId, provider: GeoProviderName): Promise<boolean> {
    const deleted = await this.keys.forget(userId, provider);
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
    const failed: SearchOutcome = { kind: "failed", error: result.error.kind, message: result.error.message };
    return caller.kind === "agent" ? forAgent(failed) : failed;
  }

  /**
   * Time a route from where I am to a destination, for an agent (eta.ts
   * says what it is told). Agents need etaToAgents, a visible presence, a
   * registered place as the destination unless they may read the precise
   * location, and are refused at or near home while skipProviderNearHome is
   * on. The answer never carries the route's geometry. The same credential
   * asking the same thing within AGENT_ANSWER_TTL_MS hears the same answer,
   * with no provider call.
   */
  async eta(userId: UserId, request: EtaRequest, caller: AgentCaller): Promise<EtaOutcome<AgentEtaAnswer>> {
    const gated = await this.gate(userId, request, caller);
    if ("kind" in gated) return gated;
    const key = answerKey(userId, caller, request, gated.precise);
    const now = this.clock().getTime();
    const kept = this.agentAnswers.get(key, now);
    if (kept) return kept;
    const timed = await this.timeRoute(userId, request, caller, gated);
    if ("kind" in timed) return forAgent(timed);
    const { route, common, precise, avoid } = timed;
    const { detail, usedPrecise } = agentDetail(route, avoid, { precise, directions: request.directions === true });
    const outcome: AgentEtaOk = {
      kind: "ok",
      precise: precise && (common.destination.kind === "address" || usedPrecise),
      answer: { ...common, precision: "approximate", ...agentNumbers(route), ...detail },
    };
    this.agentAnswers.set(key, outcome, now);
    return outcome;
  }

  /** Time a route for me in the dashboard: the provider's numbers, the steps, the stops, and the route as drawn. Near home it starts at the home place. */
  async ownerEta(userId: UserId, request: EtaRequest): Promise<EtaOutcome<OwnerEtaAnswer>> {
    const owner = { kind: "owner" } as const;
    const gated = await this.gate(userId, request, owner);
    if ("kind" in gated) return gated;
    const timed = await this.timeRoute(userId, request, owner, gated);
    if ("kind" in timed) return timed;
    const { route, common } = timed;
    return {
      kind: "ok",
      precise: false,
      answer: { ...common, precision: "exact", ...ownerNumbers(route), path: route.path, ...ownerDetail(route) },
    };
  }

  /** The gates an ETA passes before any provider is asked, and what they found. */
  private async gate(userId: UserId, request: EtaRequest, caller: AgentCaller | { kind: "owner" }): Promise<Gated | EtaRefusal> {
    const option = drivingOnlyOption(request, this.clock());
    if (option) return option;
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

    const place = places.find((p: Place) => p.name === request.to) ?? null;
    if (!place && agent && !precise) {
      return {
        kind: "denied",
        reason:
          "agents may time a route only to a registered place; an address needs precise access (read_precise_location, allowed by the person, and a reason)",
      };
    }
    return { settings, start: presence.precise, freshness: fresh.freshness, originAgeMin, places, home, precise, place };
  }

  /** The destination and the provider's route, for a request that passed the gates. */
  private async timeRoute(
    userId: UserId,
    request: EtaRequest,
    caller: AgentCaller | { kind: "owner" },
    gated: Gated,
  ): Promise<TimedRoute | EtaRefusal> {
    const { settings, start, places, home, precise, place } = gated;
    const resolved = await this.keys.resolve(userId, settings);
    if (!resolved) return { kind: "unconfigured" };
    const supported = PROVIDER_ROUTE_MODES[resolved.name];
    if (!supported.includes(request.mode)) {
      const switchTo = (await this.keys.available(userId)).filter((p) => p !== resolved.name && PROVIDER_ROUTE_MODES[p].includes(request.mode));
      return { kind: "unsupported_mode", mode: request.mode, provider: resolved.name, supported, switchTo };
    }

    const managesPlaces = caller.kind !== "agent" || caller.scopes.includes("manage_places");
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

    const origin: LatLon = home ?? start;
    const routed = await this.keys.call(userId, caller, resolved, ROUTE_ACTION[request.mode], (p) =>
      p.route({ mode: request.mode, origin, destination: target.point, departAt: request.departAt, avoid: request.avoid }),
    );
    if (routed.kind !== "ok") return failure(routed);
    const route = routed.value;
    return {
      route,
      precise,
      avoid: keepouts([start, target.point], places),
      common: {
        mode: route.mode,
        destination: { label: target.label, kind: target.kind },
        origin: home ? "home" : "current_location",
        ...(route.mode === "car" ? { traffic: route.traffic } : {}),
        departAt: route.departAt,
        provider: resolved.name,
        freshness: gated.freshness,
        originAgeMin: gated.originAgeMin,
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

/** The access log action a route call is recorded as, by mode. */
export const ROUTE_ACTION: Record<RouteMode, GeoCallAction> = {
  car: "geo.route",
  transit: "geo.route.transit",
  walk: "geo.route.walk",
  bike: "geo.route.bike",
};

/**
 * What an agent hears of a provider failure: fixed words per kind, never
 * the provider's own (a status, a message), which only the owner and the
 * access log see.
 */
export const AGENT_FAILURE_TEXT: Record<GeoErrorKind, string> = {
  auth: "the maps provider refused the key",
  quota: "the maps provider's quota or rate limit was reached",
  no_route: "no route found",
  unsupported: "the maps provider cannot answer this request",
  bad_request: "the maps provider rejected the request",
  timeout: "the maps provider did not answer in time",
  upstream: "the maps provider failed",
};

function forAgent<T extends EtaRefusal | SearchOutcome>(outcome: T): T {
  return outcome.kind === "failed" ? { ...outcome, message: AGENT_FAILURE_TEXT[outcome.error] } : outcome;
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
