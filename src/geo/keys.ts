/**
 * Which maps key a person's calls use, and the one place a provider is
 * called.
 *
 * - The key: the person's own (BYOK) first, then the operator's, which only
 *   USER_ID may use unless GEO_OPERATOR_KEY_FOR_ALL.
 * - The budget: every provider call counts against the person (a geocode and
 *   a route are two), against the key, and, for anyone but USER_ID on an
 *   operator key, against a daily cap (GEO_OPERATOR_DAILY_CAP). Counters are
 *   in memory and reset with the process.
 * - The record: each call notes how the key fared and, unless the owner made
 *   it from the dashboard, lands in the person's access log as geo.reverse,
 *   geo.geocode or geo.route under the agent or `system`, with no
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
  type GeoKeyBag,
  type GeoProvider,
  type GeoProviderName,
  type LatLon,
} from "./types.js";

/** Provider calls one person's location or key may cause per minute, whoever asks. */
export const GEO_USER_CALLS_PER_MINUTE = 30;
/** Provider calls one key may make per minute, across everyone using it. */
export const GEO_KEY_CALLS_PER_MINUTE = 60;
/** Seoul City Hall: the fixed public point a key test looks up. */
export const KEY_TEST_POINT: LatLon = { lat: 37.5663, lon: 126.9779 };

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

export type KeyTestOutcome =
  | { ok: true; label: string }
  | { ok: false; error: GeoErrorKind | "missing" | "rate_limited"; message: string };

/** How one provider call went. `rate_limited`: a budget was spent, so nothing was sent. */
export type CallResult<T> = { kind: "ok"; value: T } | { kind: "rate_limited" } | { kind: "failed"; error: GeoError };

export type GeoCallAction = Extract<AccessAction, "geo.reverse" | "geo.geocode" | "geo.route">;

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

  /** The provider to call for this person: their choice, else the first with a key; their own key before the operator's. */
  async resolve(userId: UserId, settings: PrivacySettings): Promise<ResolvedKey | null> {
    const own = new Set((await this.deps.credentials.list(userId)).filter((c) => c.status === "ok").map((c) => c.provider));
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

  async status(userId: UserId, settings: PrivacySettings): Promise<GeoStatus> {
    const resolved = await this.resolve(userId, settings);
    return {
      active: resolved && { provider: resolved.name, source: resolved.source },
      credentials: await this.deps.credentials.list(userId),
      operator: this.operatorProviders(userId),
    };
  }

  save(userId: UserId, provider: GeoProviderName, keys: GeoKeyBag): Promise<StoredGeoCredential> {
    return this.deps.credentials.put(userId, provider, keys);
  }

  delete(userId: UserId, provider: GeoProviderName): Promise<boolean> {
    return this.deps.credentials.delete(userId, provider);
  }

  /** Look up a fixed public landmark with my saved key, never my location. Counts against my budgets. */
  async test(userId: UserId, provider: GeoProviderName): Promise<KeyTestOutcome> {
    const keys = await this.deps.credentials.open(userId, provider);
    const credentials = keys && restCredentials(provider, keys);
    if (!credentials) {
      const saved = (await this.deps.credentials.list(userId)).find((c) => c.provider === provider);
      return { ok: false, error: "missing", message: saved ? UNUSABLE_KEY : "no REST key saved for this provider" };
    }
    const resolved: ResolvedKey = { provider: this.adapter(credentials), name: provider, source: "own" };
    const result = await this.call(userId, { kind: "owner" }, resolved, "geo.reverse", (p) => p.reverse(KEY_TEST_POINT));
    if (result.kind === "rate_limited") return { ok: false, error: "rate_limited", message: "too many maps requests; try again in a minute" };
    if (result.kind === "failed") return { ok: false, error: result.error.kind, message: result.error.message };
    return { ok: true, label: result.value?.label ?? "" };
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
