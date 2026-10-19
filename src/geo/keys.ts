/**
 * Which maps key a person's calls use, and the one place a provider is
 * called.
 *
 * - The key: the person's own (BYOK) for any provider first, then the
 *   operator's, which only USER_ID may use unless GEO_OPERATOR_KEY_FOR_ALL.
 * - The budget: every provider call counts against the person (a geocode and
 *   a route are two), against the key, and, for anyone but USER_ID on an
 *   operator key, against a daily cap (GEO_OPERATOR_DAILY_CAP). Counters are
 *   in memory and reset with the process.
 * - The record: each call notes how the key fared and, unless the owner made
 *   it from the dashboard, lands in the person's access log as geo.reverse,
 *   geo.geocode or geo.route (geo.route.transit, .walk, .bike by mode)
 *   under the agent or `system`, with no
 *   coordinates. A provider failure is an `error` there: nothing was decided
 *   about the caller.
 */

import type { WhereCtxConfig } from "../config.js";
import type { AccessLogStore } from "../activity/accessLogStore.js";
import type { AccessAction, AccessSurface, Credential } from "../activity/types.js";
import { RateLimiter } from "../api/rateLimit.js";
import type { PrivacySettings, TokenScope, UserId } from "../types.js";
import { log } from "../util/log.js";
import type { Clock } from "../util/time.js";
import { UNUSABLE_KEY, type GeoCredentialsStore, type StoredGeoCredential } from "./credentialsStore.js";
import type { FakeGeoProvider } from "./fake.js";
import { KakaoProvider } from "./kakao.js";
import { NaverProvider } from "./naver.js";
import {
  GEO_PROVIDERS,
  GeoError,
  restCredentials,
  roundingProvider,
  type GeoCredentials,
  type GeoErrorKind,
  type GeoProvider,
  type GeoProviderName,
  type KeyProblem,
  type LatLon,
} from "./types.js";

/** Provider calls one person's location or key may cause per minute, whoever asks. */
export const GEO_USER_CALLS_PER_MINUTE = 30;
/** Provider calls one key may make per minute, across everyone using it. */
export const GEO_KEY_CALLS_PER_MINUTE = 60;
/** Seoul City Hall: the fixed public point a key test looks up, and the start of the route it times. */
export const KEY_TEST_POINT: LatLon = { lat: 37.5663, lon: 126.9779 };
/** Seoul Station: where the key test's route ends. */
export const KEY_TEST_DESTINATION: LatLon = { lat: 37.5547, lon: 126.9707 };

/** Whose request this is: an agent's credential, the owner in the dashboard, or the server itself. */
export type GeoCaller =
  | { kind: "agent"; credential: Credential; surface: Exclude<AccessSurface, "system">; scopes: readonly TokenScope[] }
  | { kind: "owner" }
  | { kind: "system" };

const SYSTEM_CREDENTIAL: Credential = { kind: "system", id: "system", name: "WhereCtx" };

export type KeySource = "own" | "operator";

/** The provider a person's calls go to, and whose key they use. */
export interface ResolvedKey {
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

/** The provider APIs a key test tries in turn: region names (Kakao Local, Naver Reverse Geocoding), then a car route. */
export type KeyTestApi = "geocoding" | "directions";

export type KeyTestOutcome =
  | { ok: true; label: string }
  | { ok: false; error: "missing" | "rate_limited"; message: string }
  | {
      ok: false;
      error: GeoErrorKind;
      message: string;
      /** The API that failed. */
      api: KeyTestApi;
      /** What to fix. */
      code: KeyProblem;
      /** The provider's own words, every key masked. */
      providerMessage?: string;
    };

/** How one provider call went. `rate_limited`: a budget was spent, so nothing was sent. */
export type CallResult<T> = { kind: "ok"; value: T } | { kind: "rate_limited" } | { kind: "failed"; error: GeoError };

export type GeoCallAction = Extract<
  AccessAction,
  "geo.reverse" | "geo.geocode" | "geo.route" | "geo.route.transit" | "geo.route.walk" | "geo.route.bike"
>;

export interface GeoKeysDeps {
  config: WhereCtxConfig;
  credentials: GeoCredentialsStore;
  accessLog: AccessLogStore;
  clock: Clock;
  fake?: FakeGeoProvider;
  /** Replaces the network for the real adapters (tests). */
  fetch?: typeof fetch;
}

export function asGeoError(e: unknown): GeoError {
  if (e instanceof GeoError) return e;
  log.error("maps call failed unexpectedly", e);
  return new GeoError("upstream", "the maps call failed");
}

function testFailure(api: KeyTestApi, result: Exclude<CallResult<unknown>, { kind: "ok" }>): KeyTestOutcome {
  if (result.kind === "rate_limited") return { ok: false, error: "rate_limited", message: "too many maps requests; try again in a minute" };
  const { kind, message, problem, providerMessage } = result.error;
  return { ok: false, error: kind, message, api, code: problem, ...(providerMessage ? { providerMessage } : {}) };
}

export class GeoKeys {
  private readonly perUser: RateLimiter;
  private readonly perKey: RateLimiter;
  /** Operator-key calls today per person other than USER_ID, by UTC day. */
  private readonly daily = new Map<UserId, { day: string; count: number }>();
  constructor(private readonly deps: GeoKeysDeps) {
    this.perUser = new RateLimiter({ max: GEO_USER_CALLS_PER_MINUTE, clock: deps.clock });
    this.perKey = new RateLimiter({ max: GEO_KEY_CALLS_PER_MINUTE, clock: deps.clock });
  }

  private isOperator(userId: UserId): boolean {
    return userId === this.deps.config.defaultUserId;
  }

  private operatorProviders(userId: UserId): GeoProviderName[] {
    if (!this.deps.config.geo.operatorKeyForAll && !this.isOperator(userId)) return [];
    return GEO_PROVIDERS.filter((p) => this.deps.config.geo.operatorKeys[p] !== undefined);
  }

  /** Every provider is reached through `roundingProvider`, so no adapter is ever handed an unrounded point. */
  private adapter(credentials: GeoCredentials): GeoProvider {
    const common = { fetch: this.deps.fetch, now: this.deps.clock };
    return roundingProvider(
      this.deps.fake ??
        (credentials.provider === "kakao"
          ? new KakaoProvider({ restKey: credentials.restKey, ...common })
          : new NaverProvider({ clientId: credentials.clientId, clientSecret: credentials.clientSecret, ...common })),
    );
  }

  /** The chosen provider, else every provider in order. */
  private static order(settings: PrivacySettings): readonly GeoProviderName[] {
    return settings.geoProvider ? [settings.geoProvider] : GEO_PROVIDERS;
  }

  /** The provider to call for this person: their choice, else the first with a key; their own key, for any provider, before the operator's. */
  async resolve(userId: UserId, settings: PrivacySettings): Promise<ResolvedKey | null> {
    for (const name of GeoKeys.order(settings)) {
      const keys = await this.deps.credentials.open(userId, name);
      const credentials = keys && restCredentials(name, keys);
      if (credentials) return { provider: this.adapter(credentials), name, source: "own" };
    }
    const operator = this.operatorProviders(userId);
    const name = GeoKeys.order(settings).find((p) => operator.includes(p));
    return name ? { provider: this.adapter(this.deps.config.geo.operatorKeys[name]!), name, source: "operator" } : null;
  }

  /** Every provider my calls could use: one I saved a usable key for, or the operator's. */
  async available(userId: UserId): Promise<GeoProviderName[]> {
    const operator = this.operatorProviders(userId);
    const out: GeoProviderName[] = [];
    for (const name of GEO_PROVIDERS) {
      const keys = await this.deps.credentials.open(userId, name);
      if ((keys && restCredentials(name, keys)) || operator.includes(name)) out.push(name);
    }
    return out;
  }

  async status(userId: UserId, settings: PrivacySettings): Promise<GeoStatus> {
    const resolved = await this.resolve(userId, settings);
    return {
      active: resolved && { provider: resolved.name, source: resolved.source },
      credentials: await this.deps.credentials.list(userId),
      operator: this.operatorProviders(userId),
    };
  }

  /** Save a provider's REST keys, replacing those saved before; how the old ones fared is forgotten. */
  save(userId: UserId, credentials: GeoCredentials): Promise<StoredGeoCredential> {
    return this.deps.credentials.put(userId, credentials);
  }

  /** Forget a provider's keys; an unusable row goes too. False when there was nothing to forget. */
  forget(userId: UserId, provider: GeoProviderName): Promise<boolean> {
    return this.deps.credentials.delete(userId, provider);
  }

  /**
   * Look up a fixed public landmark with my saved key, then time a route
   * between two, never my location; Kakao enables Local and Mobility apart.
   * Each call counts against my budgets.
   */
  async test(userId: UserId, provider: GeoProviderName): Promise<KeyTestOutcome> {
    const keys = await this.deps.credentials.open(userId, provider);
    const credentials = keys && restCredentials(provider, keys);
    if (!credentials) {
      const saved = (await this.deps.credentials.list(userId)).find((c) => c.provider === provider);
      return { ok: false, error: "missing", message: saved?.status === "unusable" ? UNUSABLE_KEY : "no REST key saved for this provider" };
    }
    const resolved: ResolvedKey = { provider: this.adapter(credentials), name: provider, source: "own" };
    const owner: GeoCaller = { kind: "owner" };
    const region = await this.call(userId, owner, resolved, "geo.reverse", (p) => p.reverse(KEY_TEST_POINT));
    if (region.kind !== "ok") return testFailure("geocoding", region);
    const route = await this.call(userId, owner, resolved, "geo.route", (p) => p.route({ mode: "car", origin: KEY_TEST_POINT, destination: KEY_TEST_DESTINATION }));
    if (route.kind !== "ok") return testFailure("directions", route);
    return { ok: true, label: region.value?.label ?? "" };
  }

  private budgets(userId: UserId, resolved: ResolvedKey): { keys: string[]; capped: boolean } {
    const keyId = resolved.source === "own" ? `own:${userId}:${resolved.name}` : `operator:${resolved.name}`;
    return { keys: [`user:${userId}`, `key:${keyId}`], capped: resolved.source === "operator" && !this.isOperator(userId) };
  }

  /** Spend one call from every budget it counts against, or say one is spent and spend nothing. */
  private spend(userId: UserId, resolved: ResolvedKey): boolean {
    const { keys, capped } = this.budgets(userId, resolved);
    const limiters = [this.perUser, this.perKey];
    if (keys.some((k, i) => limiters[i]!.isBlocked(k))) return false;
    if (capped) {
      const day = this.deps.clock().toISOString().slice(0, 10);
      const used = this.daily.get(userId);
      const count = used?.day === day ? used.count : 0;
      if (count >= this.deps.config.geo.operatorDailyCap) return false;
      this.daily.set(userId, { day, count: count + 1 });
    }
    keys.forEach((k, i) => limiters[i]!.record(k));
    return true;
  }

  /** Make one provider call within the budgets, and note it. */
  async call<T>(
    userId: UserId,
    caller: GeoCaller,
    resolved: ResolvedKey,
    action: GeoCallAction,
    run: (provider: GeoProvider) => Promise<T>,
  ): Promise<CallResult<T>> {
    if (!this.spend(userId, resolved)) return { kind: "rate_limited" };
    let result: CallResult<T>;
    try {
      result = { kind: "ok", value: await run(resolved.provider) };
    } catch (e) {
      result = { kind: "failed", error: asGeoError(e) };
    }
    const error = result.kind === "failed" ? result.error : null;
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
          outcome: error ? "error" : "allowed",
          ...(error ? { denial: `${resolved.name} ${error.kind}: ${error.message}` } : {}),
        })
        .catch((e: unknown) => log.error("could not record a maps call", e, { action }));
    }
    return result;
  }
}
