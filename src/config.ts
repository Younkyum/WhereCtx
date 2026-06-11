/**
 * Environment configuration loader.
 *
 * Reads process.env once at startup, applies safe defaults, and exposes a typed
 * frozen config object. Also normalizes the DATABASE_URL so both libsql-style
 * (`file:./data/wherectx.db`) and docker-compose-style (`sqlite:////data/...`)
 * URLs work.
 */

import type { PrivacyMode } from "./types.js";
import { normalizeDatabaseUrl } from "./db/url.js";

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

export interface Config {
  port: number;
  host: string;
  baseUrl: string;
  databaseUrl: string;
  userId: string;
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
    staleAfterSec: number;
    retentionHours: number;
    storeRawHistory: boolean;
  };
  events: {
    /** Retention window for presence_events + webhook dead-letters (hours). */
    retentionHours: number;
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
    databaseUrl: normalizeDatabaseUrl(envStr("DATABASE_URL", "file:./data/wherectx.db")),
    userId: envStr("USER_ID", "default"),
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
      retentionHours: envInt("RETENTION_HOURS", 24),
      storeRawHistory: envBool("STORE_RAW_HISTORY", false),
    },
    events: {
      // 30 days by default. Floor of 1h so a misconfiguration cannot wipe the
      // event log out from under undelivered webhook cursors.
      retentionHours: Math.max(1, envInt("EVENT_RETENTION_HOURS", 720)),
    },
    geofence: {
      nearRadiusMultiplier,
    },
    webhooks: {
      allowPrivateTargets: envBool("WEBHOOK_ALLOW_PRIVATE_TARGETS", false),
      encryptionKey: envOptional("WEBHOOK_ENCRYPTION_KEY"),
    },
  });
}

export type { Config as WhereCtxConfig };
