/**
 * Environment configuration loader.
 *
 * Reads process.env once at startup, applies safe defaults, and exposes a typed
 * frozen config object. Also normalizes the DATABASE_URL so both libsql-style
 * (`file:./data/wherectx.db`) and docker-compose-style (`sqlite:////data/...`)
 * URLs work.
 */

import { asUserId, type PrivacyMode, type UserId } from "./types.js";
import { normalizeDatabaseUrl } from "./db/url.js";
import { MAP_KEY_PATTERN } from "./geo/mapSdk.js";
import type { GeoCredentials, GeoProviderName } from "./geo/types.js";

export { normalizeDatabaseUrl };

function envStr(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
}

function envOptional(key: string): string | undefined {
  const v = process.env[key];
  return v === undefined || v === "" ? undefined : v;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) {
    throw new Error(`Invalid integer for env ${key}: "${v}"`);
  }
  return n;
}

function envFloat(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseFloat(v);
  if (Number.isNaN(n)) {
    throw new Error(`Invalid number for env ${key}: "${v}"`);
  }
  return n;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function envPrivacy(key: string, fallback: PrivacyMode): PrivacyMode {
  const v = envOptional(key);
  if (v === undefined) return fallback;
  if (v === "hidden" || v === "coarse" || v === "precise") return v;
  throw new Error(
    `Invalid privacy mode for env ${key}: "${v}" (expected hidden|coarse|precise)`,
  );
}

/**
 * Which proxy headers name the client, for rate limiting. `none` uses the TCP
 * peer address; `cloudflare` trusts `cf-connecting-ip` (Cloudflare Tunnel);
 * `xff` trusts the first `x-forwarded-for` hop. Trust a header only when every
 * request reaches the server through that proxy, or clients can spoof it.
 */
export type TrustProxy = "none" | "cloudflare" | "xff";

function envTrustProxy(key: string): TrustProxy {
  const v = envStr(key, "none");
  if (v === "none" || v === "cloudflare" || v === "xff") return v;
  throw new Error(`Invalid value for env ${key}: "${v}" (expected none|cloudflare|xff)`);
}

export interface Config {
  port: number;
  host: string;
  baseUrl: string;
  trustProxy: TrustProxy;
  /**
   * Whether any signed-in person may create workspaces. When false, only
   * USER_ID and people who own or administer a workspace may.
   */
  allowMemberWorkspaces: boolean;
  databaseUrl: string;
  /**
   * Owner of bootstrap tokens and the first-boot settings row, and the
   * operator who may read server logs (api/admin.ts). Request paths take the
   * user from their credential.
   */
  defaultUserId: UserId;
  bootstrapTokens: {
    admin?: string;
    device?: string;
    agent?: string;
  };
  privacy: {
    /** Seeds privacy_settings.default_agent_access on first boot. */
    defaultAgentAccess: PrivacyMode;
    preciseRequiresReason: boolean;
    allowPreciseToAgent: boolean;
    hideHomeExactCoordinates: boolean;
    /** Seeds privacy_settings.protect_home_place on first boot. */
    protectHomePlace: boolean;
    /**
     * A reading something else fires (manual, a Shortcut automation, Tasker)
     * is stale after this long, and any reading received within it counts as
     * live (presence/freshness.ts).
     */
    staleAfterSec: number;
    /**
     * A connected device (OwnTracks, the mobile app, Home Assistant) is
     * offline after this long without any report. Such devices stay quiet
     * while they do not move, so silence alone is not staleness.
     */
    deviceOfflineAfterSec: number;
    retentionHours: number;
    storeRawHistory: boolean;
  };
  events: {
    /** Retention window for presence_events + webhook dead-letters (hours). */
    retentionHours: number;
  };
  sharing: {
    /** How long the share audit (grants, revokes, precise views) is kept (days). */
    auditRetentionDays: number;
  };
  activity: {
    /** How long the record of agent reads (access_log) is kept (days). */
    accessLogRetentionDays: number;
    /** How long the record of device uploads (ingest_log) is kept (days). */
    ingestLogRetentionDays: number;
  };
  geofence: {
    nearRadiusMultiplier: number;
  };
  webhooks: {
    /** Allow webhook delivery to private/reserved IPs (LAN Home Assistant etc.). */
    allowPrivateTargets: boolean;
    /**
     * Optional key used to encrypt webhook signing secrets at rest (AES-256-GCM;
     * the key is derived from this string via SHA-256). When unset, secrets are
     * stored as plaintext (with a startup warning if any hook has a secret).
     */
    encryptionKey?: string;
  };
  oauth: {
    /**
     * Let MCP clients register themselves at /oauth/register (RFC 7591). Off by
     * default: the MCP spec deprecates it in favour of Client ID Metadata
     * Documents, which need no registration.
     */
    dynamicRegistration: boolean;
  };
  geo: {
    /** Operator maps keys, the fallback when a person has saved none of their own. */
    operatorKeys: {
      kakao?: Extract<GeoCredentials, { provider: "kakao" }>;
      naver?: Extract<GeoCredentials, { provider: "naver" }>;
    };
    /** Operator map keys (a Kakao JavaScript key, a Naver Maps key id), under the same fallback rule. */
    operatorMapKeys: Partial<Record<GeoProviderName, string>>;
    /** Let every person fall back to the operator keys, not only USER_ID. */
    operatorKeyForAll: boolean;
    /**
     * Let every person fall back to the operator map keys, not only USER_ID.
     * Apart from operatorKeyForAll because map loads happen in browsers and
     * cannot be counted against GEO_OPERATOR_DAILY_CAP.
     */
    operatorMapKeyForAll: boolean;
    /** Provider calls a day each person other than USER_ID may make on an operator key. */
    operatorDailyCap: number;
    /** Answer every maps call from the fake provider (tests and the HTTP end-to-end run only). */
    fake: boolean;
  };
}

function operatorKeys(): Config["geo"]["operatorKeys"] {
  const restKey = envOptional("KAKAO_REST_API_KEY");
  const clientId = envOptional("NAVER_MAPS_CLIENT_ID");
  const clientSecret = envOptional("NAVER_MAPS_CLIENT_SECRET");
  if ((clientId === undefined) !== (clientSecret === undefined)) {
    throw new Error("NAVER_MAPS_CLIENT_ID and NAVER_MAPS_CLIENT_SECRET must be set together");
  }
  return {
    ...(restKey ? { kakao: { provider: "kakao" as const, restKey } } : {}),
    ...(clientId && clientSecret ? { naver: { provider: "naver" as const, clientId, clientSecret } } : {}),
  };
}

function operatorMapKeys(): Config["geo"]["operatorMapKeys"] {
  const keys = { kakao: ["KAKAO_JS_KEY", envOptional("KAKAO_JS_KEY")], naver: ["NAVER_MAPS_KEY_ID", envOptional("NAVER_MAPS_KEY_ID")] } as const;
  const found: Config["geo"]["operatorMapKeys"] = {};
  for (const provider of ["kakao", "naver"] as const) {
    const [name, key] = keys[provider];
    if (key === undefined) continue;
    if (!MAP_KEY_PATTERN.test(key)) throw new Error(`${name} must be 8 to 128 letters, digits, - or _`);
    found[provider] = key;
  }
  return found;
}

/** The fake maps provider never answers in production: only under NODE_ENV test or development. */
function geoFake(): boolean {
  const fake = envBool("GEO_PROVIDER_FAKE", false);
  const nodeEnv = process.env.NODE_ENV;
  if (fake && nodeEnv !== "test" && nodeEnv !== "development") {
    throw new Error("GEO_PROVIDER_FAKE is only allowed with NODE_ENV=test or NODE_ENV=development");
  }
  return fake;
}

export function loadConfig(): Config {
  const baseUrl = envStr("BASE_URL", "http://localhost:8787").replace(/\/+$/, "");
  const nearRadiusMultiplier = envFloat("NEAR_RADIUS_MULTIPLIER", 3);
  if (nearRadiusMultiplier < 1) {
    throw new Error(
      `NEAR_RADIUS_MULTIPLIER must be >= 1 (got ${nearRadiusMultiplier}); ` +
        `a value < 1 makes near_* statuses unreachable.`,
    );
  }
  return Object.freeze({
    port: envInt("PORT", 8787),
    host: envStr("HOST", "0.0.0.0"),
    baseUrl,
    trustProxy: envTrustProxy("TRUST_PROXY"),
    allowMemberWorkspaces: envBool("ALLOW_MEMBER_WORKSPACES", true),
    databaseUrl: normalizeDatabaseUrl(envStr("DATABASE_URL", "file:./data/wherectx.db")),
    defaultUserId: asUserId(envStr("USER_ID", "default")),
    bootstrapTokens: {
      admin: envOptional("ADMIN_TOKEN"),
      device: envOptional("DEVICE_TOKEN"),
      agent: envOptional("AGENT_TOKEN"),
    },
    privacy: {
      defaultAgentAccess: envPrivacy("DEFAULT_AGENT_PRIVACY", "coarse"),
      preciseRequiresReason: envBool("PRECISE_REQUIRES_REASON", true),
      allowPreciseToAgent: envBool("ALLOW_PRECISE_TO_AGENT", false),
      hideHomeExactCoordinates: envBool("HIDE_HOME_EXACT_COORDINATES", true),
      protectHomePlace: envBool("PROTECT_HOME_PLACE", true),
      staleAfterSec: envInt("STALE_AFTER_SEC", 900),
      deviceOfflineAfterSec: Math.max(60, envInt("DEVICE_OFFLINE_AFTER_SEC", 86_400)),
      retentionHours: envInt("RETENTION_HOURS", 24),
      storeRawHistory: envBool("STORE_RAW_HISTORY", false),
    },
    events: {
      // 30 days by default. Floor of 1h so a misconfiguration cannot wipe the
      // event log out from under undelivered webhook cursors.
      retentionHours: Math.max(1, envInt("EVENT_RETENTION_HOURS", 720)),
    },
    sharing: {
      auditRetentionDays: Math.max(1, envInt("SHARE_AUDIT_RETENTION_DAYS", 365)),
    },
    activity: {
      accessLogRetentionDays: Math.max(1, envInt("ACCESS_LOG_RETENTION_DAYS", 90)),
      ingestLogRetentionDays: Math.max(1, envInt("INGEST_LOG_RETENTION_DAYS", 7)),
    },
    geofence: {
      nearRadiusMultiplier,
    },
    webhooks: {
      allowPrivateTargets: envBool("WEBHOOK_ALLOW_PRIVATE_TARGETS", false),
      encryptionKey: envOptional("WEBHOOK_ENCRYPTION_KEY"),
    },
    oauth: {
      dynamicRegistration: envBool("OAUTH_DYNAMIC_REGISTRATION", false),
    },
    geo: {
      operatorKeys: operatorKeys(),
      operatorMapKeys: operatorMapKeys(),
      operatorKeyForAll: envBool("GEO_OPERATOR_KEY_FOR_ALL", false),
      operatorMapKeyForAll: envBool("GEO_OPERATOR_MAP_KEY_FOR_ALL", false),
      operatorDailyCap: Math.max(0, envInt("GEO_OPERATOR_DAILY_CAP", 200)),
      fake: geoFake(),
    },
  });
}

export type { Config as WhereCtxConfig };
