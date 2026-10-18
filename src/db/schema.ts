/**
 * Drizzle ORM schema for the WhereCtx SQLite store (plan section 9.4 / 10).
 *
 * Design notes:
 * - `presence` holds exactly one current row per user.
 * - Every user-data table carries a NOT NULL `user_id` with no schema default:
 *   a default would make `userId` optional in Drizzle's insert types, letting a
 *   forgotten owner silently land rows in another tenant. Migration 0004 rebuilds
 *   the pre-multi-user tables and backfills their owner in SQL.
 * - Tokens are stored as SHA-256 hashes; the raw secret is never persisted.
 * - Scopes / event lists are stored as JSON text columns for portability.
 * - Timestamps are ISO-8601 strings for round-trip fidelity with the API.
 */

import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type {
  CoarsePlaceType,
  IngestSource,
  Motion,
  PlaceType,
  PresenceEventType,
  PresenceStatus,
  PrivacyMode,
  ShareLevel,
  TokenRole,
  TokenScope,
} from "../types.js";
import type { WorkspaceRole } from "../accounts/types.js";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";

export const tokens = sqliteTable(
  "tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    role: text("role").$type<TokenRole>().notNull(),
    scopes: text("scopes", { mode: "json" }).$type<TokenScope[]>().notNull(),
    tokenHash: text("token_hash").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
  },
  (t) => ({
    tokenHashIdx: uniqueIndex("tokens_token_hash_idx").on(t.tokenHash),
    userIdx: index("tokens_user_idx").on(t.userId),
  }),
);

export const places = sqliteTable(
  "places",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    label: text("label"),
    lat: real("lat").notNull(),
    lon: real("lon").notNull(),
    radiusM: real("radius_m").notNull(),
    type: text("type").$type<PlaceType>().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    nameIdx: uniqueIndex("places_user_name_idx").on(t.userId, t.name),
  }),
);

export const presence = sqliteTable("presence", {
  userId: text("user_id").primaryKey(),
  status: text("status").$type<PresenceStatus>().notNull(),
  label: text("label"),

  preciseLat: real("precise_lat"),
  preciseLon: real("precise_lon"),
  accuracyM: real("accuracy_m"),
  altitudeM: real("altitude_m"),
  speedMps: real("speed_mps"),
  headingDeg: real("heading_deg"),

  geohash: text("geohash"),
  city: text("city"),
  area: text("area"),
  coarsePlaceType: text("coarse_place_type").$type<CoarsePlaceType>(),

  motion: text("motion").$type<Motion>(),

  batteryLevel: real("battery_level"),
  batteryCharging: integer("battery_charging", { mode: "boolean" }),

  source: text("source").$type<IngestSource>().notNull(),

  privacyMode: text("privacy_mode").$type<PrivacyMode>().notNull(),
  allowPreciseToAgents: integer("allow_precise_to_agents", { mode: "boolean" })
    .notNull()
    .default(false),

  /** Name of the place the user is currently inside, for enter/leave events. */
  currentPlaceName: text("current_place_name"),
  /** Whether a `presence.became_stale` event has already fired for this reading. */
  staleEventFired: integer("stale_event_fired", { mode: "boolean" })
    .notNull()
    .default(false),

  updatedAt: text("updated_at").notNull(),
  receivedAt: text("received_at").notNull(),
  staleAfterSec: integer("stale_after_sec").notNull(),
});

export const presenceEvents = sqliteTable(
  "presence_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    type: text("type").$type<PresenceEventType>().notNull(),
    placeName: text("place_name"),
    status: text("status"),
    source: text("source"),
    viewerUserId: text("viewer_user_id"),
    shareLevel: text("share_level").$type<ShareLevel>(),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    createdAtIdx: index("presence_events_created_at_idx").on(t.createdAt),
    // listRecent/listSince filter by user_id then order/range on the
    // (created_at, id) keyset cursor.
    userCreatedIdx: index("presence_events_user_created_idx").on(
      t.userId,
      t.createdAt,
      t.id,
    ),
  }),
);

export const locationHistory = sqliteTable(
  "location_history",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    lat: real("lat").notNull(),
    lon: real("lon").notNull(),
    accuracyM: real("accuracy_m"),
    source: text("source"),
    recordedAt: text("recorded_at").notNull(),
  },
  (t) => ({
    recordedAtIdx: index("location_history_recorded_at_idx").on(t.recordedAt),
    // listRecent/prune both filter by user_id then range on recorded_at.
    userRecordedIdx: index("location_history_user_recorded_idx").on(
      t.userId,
      t.recordedAt,
    ),
  }),
);

export const privacySettings = sqliteTable("privacy_settings", {
  userId: text("user_id").primaryKey(),
  defaultAgentAccess: text("default_agent_access").$type<PrivacyMode>().notNull(),
  allowPreciseLocation: integer("allow_precise_location", { mode: "boolean" })
    .notNull()
    .default(false),
  preciseRequiresReason: integer("precise_requires_reason", { mode: "boolean" })
    .notNull()
    .default(true),
  preciseRequiresApproval: integer("precise_requires_approval", {
    mode: "boolean",
  })
    .notNull()
    .default(false),
  hideHomeExactCoordinates: integer("hide_home_exact_coordinates", {
    mode: "boolean",
  })
    .notNull()
    .default(true),
  protectHomePlace: integer("protect_home_place", { mode: "boolean" })
    .notNull()
    .default(true),
  retentionHours: integer("retention_hours").notNull().default(24),
  storeRawHistory: integer("store_raw_history", { mode: "boolean" })
    .notNull()
    .default(false),
  updatedAt: text("updated_at").notNull(),
});

export const webhooks = sqliteTable(
  "webhooks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    url: text("url").notNull(),
    // JSON array of PresenceEventType, or ["*"] for all events.
    events: text("events", { mode: "json" }).$type<string[]>().notNull(),
    secret: text("secret"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    /** Delivery cursor: ISO createdAt of the last event delivered to this hook. */
    cursor: text("cursor"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    userIdx: index("webhooks_user_idx").on(t.userId),
  }),
);

/**
 * Dead-letter log for webhook events that could not be delivered after the
 * dispatcher's max attempts. Makes the drop durable and admin-visible instead
 * of a silent stdout warning (review finding H3).
 */
export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    webhookId: text("webhook_id").notNull(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    error: text("error"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    webhookIdx: index("webhook_deliveries_webhook_idx").on(t.webhookId),
  }),
);

export const reminders = sqliteTable(
  "reminders",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    placeName: text("place_name").notNull(),
    message: text("message").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull(),
    triggeredAt: text("triggered_at"),
  },
  (t) => ({
    userActiveIdx: index("reminders_user_active_idx").on(t.userId, t.active),
  }),
);

/**
 * Human accounts. `id` is the same key every user-data table calls user_id.
 * `webauthn_handle` (32 random bytes, hex) is the WebAuthn user.id handed to
 * authenticators, so the internal id never leaves the server that way.
 */
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    webauthnHandle: text("webauthn_handle").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    handleIdx: uniqueIndex("users_webauthn_handle_idx").on(t.webauthnHandle),
  }),
);

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
});

export const memberships = sqliteTable(
  "memberships",
  {
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").$type<WorkspaceRole>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.userId] }),
    userIdx: index("memberships_user_idx").on(t.userId),
  }),
);

/**
 * Find-My style location sharing between two people: `owner` lets `viewer`
 * see their presence at `level`. A share only counts while the two still
 * belong to a common workspace (checked on every write and read).
 */
export const locationShares = sqliteTable(
  "location_shares",
  {
    ownerUserId: text("owner_user_id").notNull(),
    viewerUserId: text("viewer_user_id").notNull(),
    level: text("level").$type<ShareLevel>().notNull(),
    /** Withhold exact coordinates while the owner is at or near home. */
    hideHomeExact: integer("hide_home_exact", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ownerUserId, t.viewerUserId] }),
    viewerIdx: index("location_shares_viewer_idx").on(t.viewerUserId),
  }),
);

/** WebAuthn credentials. `public_key` is the COSE key, base64url. */
export const passkeys = sqliteTable(
  "passkeys",
  {
    credentialId: text("credential_id").primaryKey(),
    userId: text("user_id").notNull(),
    publicKey: text("public_key").notNull(),
    counter: integer("counter").notNull(),
    transports: text("transports", { mode: "json" })
      .$type<AuthenticatorTransportFuture[]>()
      .notNull(),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
  },
  (t) => ({
    userIdx: index("passkeys_user_idx").on(t.userId),
  }),
);

/** Browser sessions. Only the SHA-256 of the cookie value is stored. */
export const sessions = sqliteTable(
  "sessions",
  {
    idHash: text("id_hash").primaryKey(),
    userId: text("user_id").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    /** Last passkey (or recovery/access code) proof; gates sensitive changes. */
    reauthAt: text("reauth_at").notNull(),
    userAgent: text("user_agent"),
  },
  (t) => ({
    userIdx: index("sessions_user_idx").on(t.userId),
    expiresIdx: index("sessions_expires_idx").on(t.expiresAt),
  }),
);

export const invites = sqliteTable(
  "invites",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    role: text("role").$type<WorkspaceRole>().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
    usedBy: text("used_by"),
  },
  (t) => ({
    tokenHashIdx: uniqueIndex("invites_token_hash_idx").on(t.tokenHash),
    workspaceIdx: index("invites_workspace_idx").on(t.workspaceId),
  }),
);

/**
 * Recovery codes: `lookup_id` is the public first group of the code and finds
 * the row; only the SHA-256 of the remaining secret part is stored.
 */
export const recoveryCodes = sqliteTable(
  "recovery_codes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    lookupId: text("lookup_id").notNull(),
    secretHash: text("secret_hash").notNull(),
    usedAt: text("used_at"),
  },
  (t) => ({
    lookupIdx: index("recovery_codes_lookup_idx").on(t.lookupId),
    userIdx: index("recovery_codes_user_idx").on(t.userId),
  }),
);

/** Operator-issued one-time codes that let a user register a passkey (reset-access). */
export const accessCodes = sqliteTable(
  "access_codes",
  {
    userId: text("user_id").primaryKey(),
    codeHash: text("code_hash").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => ({
    codeHashIdx: uniqueIndex("access_codes_code_hash_idx").on(t.codeHash),
  }),
);

/** Per-install secrets generated on first boot (ceremony signing key, setup code hash). */
export const serverSecrets = sqliteTable("server_secrets", {
  name: text("name").primaryKey(),
  value: text("value").notNull(),
  createdAt: text("created_at").notNull(),
});

/** Spent WebAuthn ceremony nonces, kept until the ceremony would have expired anyway. */
export const usedNonces = sqliteTable(
  "used_nonces",
  {
    nonce: text("nonce").primaryKey(),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => ({
    expiresIdx: index("used_nonces_expires_idx").on(t.expiresAt),
  }),
);

export const schema = {
  tokens,
  places,
  presence,
  presenceEvents,
  locationHistory,
  privacySettings,
  webhooks,
  webhookDeliveries,
  reminders,
  users,
  workspaces,
  memberships,
  locationShares,
  passkeys,
  sessions,
  invites,
  recoveryCodes,
  accessCodes,
  serverSecrets,
  usedNonces,
};

// NOTE: all timestamp columns store app-generated ISO-8601 strings
// (`new Date().toISOString()`). We intentionally avoid SQL CURRENT_TIMESTAMP
// defaults, which emit a different `YYYY-MM-DD HH:MM:SS` format and would break
// `updatedAgoSec` math and lexical sorting.
