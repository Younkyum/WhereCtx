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
  TokenRole,
  TokenScope,
} from "../types.js";

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
};

// NOTE: all timestamp columns store app-generated ISO-8601 strings
// (`new Date().toISOString()`). We intentionally avoid SQL CURRENT_TIMESTAMP
// defaults, which emit a different `YYYY-MM-DD HH:MM:SS` format and would break
// `updatedAgoSec` math and lexical sorting.
