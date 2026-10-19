/**
 * Everything WhereCtx asks a maps provider, for one person at a time.
 *
 * - Which provider and key: the person's own key first (BYOK), then the
 *   operator's, which only USER_ID may use unless GEO_OPERATOR_KEY_FOR_ALL.
 * - What leaves the server: a point rounded to three decimals (about 100 m),
 *   never while maps are off, and never the live location at or near home
 *   while skipProviderNearHome is on.
 * - Who is told: each provider call made with the person's location or key
 *   lands in their access log as geo.reverse, geo.geocode or geo.route, under
 *   the agent that caused it or `system` for the background area lookup. No
 *   coordinates are logged.
 *
 * The background area lookup runs after a reading is stored, outside the
 * ingest path, throttled per person, and from a per-person cache first.
 */

import type { WhereCtxConfig } from "../config.js";
import type { AccessLogStore } from "../activity/accessLogStore.js";
import type { AccessAction, AccessSurface, Credential } from "../activity/types.js";
import { haversineMeters } from "../geofence/distance.js";
import { isAtOrNearHome } from "../privacy/policy.js";
import type { SettingsStore } from "../privacy/settingsStore.js";
import type { PlacesStore } from "../store/placesStore.js";
import type { PresenceStore } from "../store/presenceStore.js";
import { RateLimiter } from "../api/rateLimit.js";
import type { Place, PrivacySettings, UserId } from "../types.js";
import { log } from "../util/log.js";
import { KeyedMutex } from "../util/mutex.js";
import { isStale, secondsSince, systemClock, type Clock } from "../util/time.js";
import type { GeoCacheStore } from "./cacheStore.js";
import type { GeoCredentialsStore, StoredGeoCredential } from "./credentialsStore.js";
import { FakeGeoProvider } from "./fake.js";
import { KakaoProvider } from "./kakao.js";
import { NaverProvider } from "./naver.js";
import {
  GEO_PROVIDERS,
  GeoError,
  restCredentials,
  roundPoint,
  type GeocodeCandidate,
  type GeoCredentials,
  type GeoErrorKind,
  type GeoProvider,
  type GeoProviderName,
  type LatLon,
  type ReverseResult,
  type RouteAvoid,
  type RouteResult,
} from "./types.js";

/** Refresh the area at most this often per person... */
export const AREA_REFRESH_MIN_MS = 120_000;
/** ...and only after moving this far from where it was last looked up. */
export const AREA_REFRESH_MOVE_M = 200;
/** Provider calls per caller (agent credential, or the owner) per minute. */
export const GEO_CALLS_PER_MINUTE = 30;
/** Seoul City Hall: the fixed public point a key test looks up. */
export const KEY_TEST_POINT: LatLon = { lat: 37.5663, lon: 126.9779 };

/** Whose request this is: an agent's credential, the owner in the dashboard, or the server itself. */
export type GeoCaller =
  | { kind: "agent"; credential: Credential; surface: Exclude<AccessSurface, "system">; seesPlaceCoordinates: boolean }
  | { kind: "owner" }
  | { kind: "system" };

const SYSTEM_CREDENTIAL: Credential = { kind: "system", id: "system", name: "WhereCtx" };

export type KeySource = "own" | "operator";

interface Resolved {
  provider: GeoProvider;
  name: GeoProviderName;
  source: KeySource;
}

export interface GeoStatus {
  /** The provider calls would use now, and whose key; null when none is set up. */
  active: { provider: GeoProviderName; source: KeySource } | null;
  /** My own saved keys, never the key itself. */
  credentials: StoredGeoCredential[];
  /** Operator keys I may fall back to. */
  operator: GeoProviderName[];
}

export interface EtaRequest {
  /** A registered place's name, else an address or a place to search for. */
  to: string;
  /** Which search result, numbered from 1, when the search finds several. */
  pick?: number;
  departAt?: Date;
  avoid?: readonly RouteAvoid[];
}

export interface EtaAnswer {
  destination: { label: string; kind: "place" | "address" };
  /** The route starts at the current location, or at the home place while near home. */
  origin: "current_location" | "home";
  durationMin: number;
  distanceKm: number;
  trafficAware: boolean;
  traffic: RouteResult["traffic"];
  departAt: string;
  arriveAt: string;
  summary: string[];
  steps: string[];
  tollFare?: number;
  taxiFare?: number;
  provider: GeoProviderName;
  /** Present only when the caller may see the destination's coordinates. */
  deepLinks?: { kakaoMap: string; naverMap: string };
}

/** A search result as the caller may see it: coordinates only for the owner or a place manager. */
export type CandidateView = Omit<GeocodeCandidate, "lat" | "lon"> & Partial<Pick<GeocodeCandidate, "lat" | "lon">>;

/** What came of an ETA request, each case with what the caller is told. */
export type EtaOutcome =
  | { kind: "ok"; answer: EtaAnswer }
  | { kind: "hidden" }
  | { kind: "denied"; reason: string }
  | { kind: "no_location" }
  | { kind: "stale"; updatedAgoSec: number }
  | { kind: "not_found"; reason: string }
  | { kind: "ambiguous"; candidates: CandidateView[] }
  | { kind: "rate_limited" }
  | { kind: "unconfigured" }
  | { kind: "failed"; error: GeoErrorKind; message: string };

export type SearchOutcome =
  | { kind: "ok"; candidates: GeocodeCandidate[]; provider: GeoProviderName }
  | { kind: "rate_limited" }
  | { kind: "unconfigured" }
  | { kind: "failed"; error: GeoErrorKind; message: string };

export type KeyTestOutcome = { ok: true; label: string } | { ok: false; error: GeoErrorKind | "missing"; message: string };

/** The area a reading resolved to, or null to clear it. `forPoint`: the reading it was looked up for. */
export type AreaUpdate = { region: ReverseResult | null; forPoint?: LatLon };

export interface GeoServiceDeps {
  config: WhereCtxConfig;
  credentials: GeoCredentialsStore;
  cache: GeoCacheStore;
  settings: SettingsStore;
  presence: PresenceStore;
  places: PlacesStore;
  accessLog: AccessLogStore;
  /** Writes presence city/area under the presence mutex (PresenceService.setArea). */
  setArea: (userId: UserId, update: AreaUpdate) => Promise<void>;
  clock?: Clock;
  /** Replaces the network for the real adapters (tests). */
  fetch?: typeof fetch;
}

/** Map links to the destination; the origin is left to the app (the device's own location). */
export function deepLinks(label: string, point: LatLon, appName: string): EtaAnswer["deepLinks"] {
  const name = encodeURIComponent(label);
  return {
    kakaoMap: `https://map.kakao.com/link/to/${name},${point.lat},${point.lon}`,
    naverMap: `nmap://navigation?dlat=${point.lat}&dlng=${point.lon}&dname=${name}&appname=${encodeURIComponent(appName)}`,
  };
}

export class GeoService {
  private readonly clock: Clock;
  private readonly limiter: RateLimiter;
  private readonly areaMutex = new KeyedMutex();
  /** Where and when each person's area was last looked up at a provider. */
  private readonly lastLookup = new Map<UserId, { at: number; point: LatLon }>();
  private readonly inFlight = new Set<Promise<void>>();
  /** Answers every call when GEO_PROVIDER_FAKE is on. */
  readonly fake?: FakeGeoProvider;

  constructor(private readonly deps: GeoServiceDeps) {
    this.clock = deps.clock ?? systemClock;
    this.limiter = new RateLimiter({ max: GEO_CALLS_PER_MINUTE, clock: this.clock });
    if (deps.config.geo.fake) this.fake = new FakeGeoProvider(this.clock);
  }

  // ---- keys ----

  private mayUseOperatorKeys(userId: UserId): boolean {
    return this.deps.config.geo.operatorKeyForAll || userId === this.deps.config.defaultUserId;
  }

  private operatorProviders(userId: UserId): GeoProviderName[] {
    if (!this.mayUseOperatorKeys(userId)) return [];
    return GEO_PROVIDERS.filter((p) => this.deps.config.geo.operatorKeys[p] !== undefined);
  }

  private adapter(credentials: GeoCredentials): GeoProvider {
    if (this.fake) return this.fake;
    const common = { fetch: this.deps.fetch, now: this.clock };
    return credentials.provider === "kakao"
      ? new KakaoProvider({ restKey: credentials.restKey, ...common })
      : new NaverProvider({ clientId: credentials.clientId, clientSecret: credentials.clientSecret, ...common });
  }

  /** The provider to call for this person: their choice, else the first with a key; their own key before the operator's. */
  private async resolve(userId: UserId, settings: PrivacySettings): Promise<Resolved | null> {
    const own = new Set((await this.deps.credentials.list(userId)).map((c) => c.provider));
    const operator = new Set(this.operatorProviders(userId));
    const order = settings.geoProvider ? [settings.geoProvider] : GEO_PROVIDERS;
    for (const name of order) {
      if (own.has(name)) {
        const keys = await this.deps.credentials.open(userId, name);
        const credentials = keys && restCredentials(name, keys);
        if (credentials) return { provider: this.adapter(credentials), name, source: "own" };
      }
      if (operator.has(name)) {
        return { provider: this.adapter(this.deps.config.geo.operatorKeys[name]!), name, source: "operator" };
      }
    }
    return null;
  }

  async status(userId: UserId): Promise<GeoStatus> {
    const settings = await this.deps.settings.getOrSeed(userId);
    const resolved = await this.resolve(userId, settings);
    return {
      active: resolved && { provider: resolved.name, source: resolved.source },
      credentials: await this.deps.credentials.list(userId),
      operator: this.operatorProviders(userId),
    };
  }

  /** Save some of a provider's keys; kinds not named keep their stored value. */
  saveCredential(userId: UserId, provider: GeoProviderName, keys: Record<string, string>): Promise<StoredGeoCredential> {
    return this.deps.credentials.put(userId, provider, keys);
  }

  deleteCredential(userId: UserId, provider: GeoProviderName): Promise<boolean> {
    return this.deps.credentials.delete(userId, provider);
  }

  /** Look up a fixed public landmark with my saved key, never my location. */
  async testCredential(userId: UserId, provider: GeoProviderName): Promise<KeyTestOutcome> {
    const keys = await this.deps.credentials.open(userId, provider);
    const credentials = keys && restCredentials(provider, keys);
    if (!credentials) return { ok: false, error: "missing", message: "no REST key saved for this provider" };
    try {
      const region = await this.adapter(credentials).reverse(KEY_TEST_POINT);
      await this.deps.credentials.markUsed(userId, provider, null);
      return { ok: true, label: region?.label ?? "" };
    } catch (e) {
      const error = asGeoError(e);
      await this.deps.credentials.markUsed(userId, provider, error.message);
      return { ok: false, error: error.kind, message: error.message };
    }
  }

  // ---- calls ----

  private callerKey(userId: UserId, caller: GeoCaller): string {
    return caller.kind === "agent" ? `agent:${caller.credential.id}` : `${caller.kind}:${userId}`;
  }

  /** Count a call against the caller's minute, or say it is over. */
  private overLimit(userId: UserId, caller: GeoCaller): boolean {
    const key = this.callerKey(userId, caller);
    if (this.limiter.isBlocked(key)) return true;
    this.limiter.record(key);
    return false;
  }

  /**
   * Make one provider call and note it: the key's last use or error, and an
   * access log row under the agent or `system`. The owner's own calls are
   * not access-logged, as their own reads are not.
   */
  private async call<T>(
    userId: UserId,
    caller: GeoCaller,
    resolved: Resolved,
    action: Extract<AccessAction, "geo.reverse" | "geo.geocode" | "geo.route">,
    run: (provider: GeoProvider) => Promise<T>,
  ): Promise<T> {
    let error: GeoError | null = null;
    try {
      return await run(resolved.provider);
    } catch (e) {
      error = asGeoError(e);
      throw error;
    } finally {
      if (resolved.source === "own") {
        await this.deps.credentials.markUsed(userId, resolved.name, error?.message ?? null).catch((e: unknown) => {
          log.error("could not note a maps key's use", e);
        });
      }
      const credential = caller.kind === "agent" ? caller.credential : caller.kind === "system" ? SYSTEM_CREDENTIAL : null;
      if (credential) {
        await this.deps.accessLog
          .record(userId, {
            credential,
            surface: caller.kind === "agent" ? caller.surface : "system",
            action,
            precise: false,
            outcome: error ? (error.kind === "timeout" || error.kind === "upstream" ? "error" : "denied") : "allowed",
            ...(error ? { denial: `${resolved.name}: ${error.message}` } : {}),
          })
          .catch((e: unknown) => log.error("could not record a maps call", e, { action }));
      }
    }
  }

  /** Search an address or a place by name. Sends only the text. */
  async search(userId: UserId, query: string, caller: GeoCaller): Promise<SearchOutcome> {
    const settings = await this.deps.settings.getOrSeed(userId);
    const resolved = await this.resolve(userId, settings);
    if (!resolved) return { kind: "unconfigured" };
    if (this.overLimit(userId, caller)) return { kind: "rate_limited" };
    try {
      const candidates = await this.call(userId, caller, resolved, "geo.geocode", (p) => p.geocode(query));
      return { kind: "ok", candidates, provider: resolved.name };
    } catch (e) {
      const error = asGeoError(e);
      return { kind: "failed", error: error.kind, message: error.message };
    }
  }

  /**
   * Time a car route from where I am to a destination. Agents need
   * etaToAgents and a visible presence; everyone needs the maps switch on and
   * a fresh reading. The origin never leaves the server unrounded, and never
   * leaves it at all near home while skipProviderNearHome is on: the home
   * place stands in for it.
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
    if (isStale(presence.updatedAt, presence.staleAfterSec, this.clock)) {
      return { kind: "stale", updatedAgoSec: secondsSince(presence.updatedAt, this.clock) };
    }
    const places = await this.deps.places.list(userId);
    const nearHome = settings.skipProviderNearHome && isAtOrNearHome(presence);
    const home = places.find((p) => p.type === "home");
    if (nearHome && !home) return { kind: "denied", reason: "at home with no home place to start from" };
    const origin = roundPoint(nearHome ? home! : presence.precise);

    const resolved = await this.resolve(userId, settings);
    if (!resolved) return { kind: "unconfigured" };
    if (this.overLimit(userId, caller)) return { kind: "rate_limited" };

    const seesCoordinates = caller.kind !== "agent" || caller.seesPlaceCoordinates;
    let target: { label: string; kind: "place" | "address"; point: LatLon; showLinks: boolean };
    const place = places.find((p: Place) => p.name === request.to);
    if (place) {
      target = { label: place.name, kind: "place", point: place, showLinks: seesCoordinates };
    } else {
      let candidates: GeocodeCandidate[];
      try {
        candidates = await this.call(userId, caller, resolved, "geo.geocode", (p) => p.geocode(request.to));
      } catch (e) {
        const error = asGeoError(e);
        return { kind: "failed", error: error.kind, message: error.message };
      }
      const chosen = pickCandidate(candidates, request.pick);
      if (chosen.kind === "none") return { kind: "not_found", reason: `no place named, and nothing found for, "${request.to}"` };
      if (chosen.kind === "ambiguous") return { kind: "ambiguous", candidates: candidateViews(candidates, seesCoordinates) };
      // The caller named this address, so linking to it shows them nothing new.
      target = { label: chosen.candidate.label, kind: "address", point: chosen.candidate, showLinks: true };
    }

    let route: RouteResult;
    try {
      route = await this.call(userId, caller, resolved, "geo.route", (p) =>
        p.route({ origin, destination: target.point, departAt: request.departAt, avoid: request.avoid }),
      );
    } catch (e) {
      const error = asGeoError(e);
      return { kind: "failed", error: error.kind, message: error.message };
    }
    const arrive = new Date(Date.parse(route.departAt) + route.durationSec * 1000);
    return {
      kind: "ok",
      answer: {
        destination: { label: target.label, kind: target.kind },
        origin: nearHome ? "home" : "current_location",
        durationMin: Math.max(1, Math.round(route.durationSec / 60)),
        distanceKm: Math.round(route.distanceM / 100) / 10,
        trafficAware: route.traffic === "live",
        traffic: route.traffic,
        departAt: route.departAt,
        arriveAt: arrive.toISOString(),
        summary: route.summary,
        steps: route.steps,
        ...(route.tollFare !== undefined ? { tollFare: route.tollFare } : {}),
        ...(route.taxiFare !== undefined ? { taxiFare: route.taxiFare } : {}),
        provider: resolved.name,
        ...(target.showLinks ? { deepLinks: deepLinks(target.label, target.point, this.deps.config.baseUrl) } : {}),
      },
    };
  }

  // ---- the background area ----

  /**
   * Bring my area up to date with my current reading, in the background.
   * Returns at once; `settled()` waits for every lookup still running.
   */
  refreshArea(userId: UserId): void {
    const run = this.areaMutex.run(userId, () => this.refreshAreaLocked(userId)).catch((e: unknown) => {
      log.error("area lookup failed", e);
    });
    this.inFlight.add(run);
    void run.finally(() => this.inFlight.delete(run));
  }

  /** Wait for every background lookup started so far (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  private async refreshAreaLocked(userId: UserId): Promise<void> {
    const [settings, presence] = await Promise.all([
      this.deps.settings.getOrSeed(userId),
      this.deps.presence.getCurrent(userId),
    ]);
    const hasArea = presence?.coarse?.area !== undefined || presence?.coarse?.city !== undefined;
    /** Drop the area; `forget` also lifts the throttle, which a failed call keeps so errors cannot loop. */
    const clear = async (forget = true) => {
      if (forget) this.lastLookup.delete(userId);
      if (hasArea) await this.deps.setArea(userId, { region: null });
    };
    if (!presence?.precise || !settings.geoEnabled) return clear();
    // Near home nothing is sent; the status already says home.
    if (settings.skipProviderNearHome && isAtOrNearHome(presence)) return clear();

    const here = presence.precise;
    const last = this.lastLookup.get(userId);
    const moved = !last || haversineMeters(last.point.lat, last.point.lon, here.lat, here.lon) > AREA_REFRESH_MOVE_M;
    if (hasArea && !moved) return;

    // From here on the area on record is for somewhere else: replace it or drop it.
    const resolved = await this.resolve(userId, settings);
    if (!resolved) return clear();
    const cell = roundPoint(here);
    const cached = await this.deps.cache.get(userId, resolved.name, cell);
    if (cached.hit) {
      await this.deps.setArea(userId, { region: cached.result, forPoint: here });
      return;
    }
    const now = this.clock().getTime();
    if (last && now - last.at < AREA_REFRESH_MIN_MS) return;
    this.lastLookup.set(userId, { at: now, point: here });
    let region: ReverseResult | null;
    try {
      region = await this.call(userId, { kind: "system" }, resolved, "geo.reverse", (p) => p.reverse(cell));
    } catch (e) {
      log.warn("area lookup failed", { provider: resolved.name, kind: asGeoError(e).kind });
      return clear(false);
    }
    await this.deps.cache.put(userId, resolved.name, cell, region);
    await this.deps.setArea(userId, { region, forPoint: here });
  }

  prune(): Promise<number> {
    return this.deps.cache.prune();
  }
}

function asGeoError(e: unknown): GeoError {
  if (e instanceof GeoError) return e;
  log.error("maps call failed unexpectedly", e);
  return new GeoError("upstream", "the maps call failed");
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
