/**
 * Presence repository: maps the single current `presence` row to/from the
 * domain `PresenceContext`, plus two internal fields the service needs but
 * agents never see: `currentPlaceName` (enter/leave diffing) and
 * `staleEventFired` (so `presence.became_stale` fires once per reading).
 */

import { eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { presence } from "../db/schema.js";
import {
  asUserId,
  type CoarsePlaceType,
  type IngestSource,
  type Motion,
  type PresenceContext,
  type PrivacyMode,
  type PresenceStatus,
  type UserId,
} from "../types.js";

/** Domain presence plus internal bookkeeping fields. */
export interface StoredPresence extends PresenceContext {
  currentPlaceName?: string;
  staleEventFired: boolean;
}

interface PresenceRow {
  userId: string;
  status: PresenceStatus;
  label: string | null;
  preciseLat: number | null;
  preciseLon: number | null;
  accuracyM: number | null;
  altitudeM: number | null;
  speedMps: number | null;
  headingDeg: number | null;
  geohash: string | null;
  city: string | null;
  area: string | null;
  coarsePlaceType: CoarsePlaceType | null;
  motion: Motion | null;
  batteryLevel: number | null;
  batteryCharging: boolean | null;
  source: IngestSource;
  privacyMode: PrivacyMode;
  allowPreciseToAgents: boolean;
  currentPlaceName: string | null;
  staleEventFired: boolean;
  updatedAt: string;
  receivedAt: string;
  staleAfterSec: number;
}

function rowToStored(row: PresenceRow): StoredPresence {
  const hasPrecise = row.preciseLat !== null && row.preciseLon !== null;
  return {
    userId: asUserId(row.userId),
    status: row.status,
    label: row.label ?? undefined,
    precise: hasPrecise
      ? {
          lat: row.preciseLat as number,
          lon: row.preciseLon as number,
          accuracyM: row.accuracyM ?? undefined,
          altitudeM: row.altitudeM ?? undefined,
          speedMps: row.speedMps ?? undefined,
          headingDeg: row.headingDeg ?? undefined,
        }
      : undefined,
    coarse:
      row.geohash || row.city || row.area || row.coarsePlaceType
        ? {
            geohash: row.geohash ?? undefined,
            city: row.city ?? undefined,
            area: row.area ?? undefined,
            placeType: row.coarsePlaceType ?? undefined,
          }
        : undefined,
    motion: row.motion ?? undefined,
    battery:
      row.batteryLevel === null
        ? undefined
        : { level: row.batteryLevel, charging: row.batteryCharging ?? undefined },
    source: row.source,
    privacy: { mode: row.privacyMode, allowPreciseToAgents: row.allowPreciseToAgents },
    updatedAt: row.updatedAt,
    receivedAt: row.receivedAt,
    staleAfterSec: row.staleAfterSec,
    currentPlaceName: row.currentPlaceName ?? undefined,
    staleEventFired: row.staleEventFired,
  };
}

function storedToRow(p: StoredPresence): PresenceRow {
  return {
    userId: p.userId,
    status: p.status,
    label: p.label ?? null,
    preciseLat: p.precise?.lat ?? null,
    preciseLon: p.precise?.lon ?? null,
    accuracyM: p.precise?.accuracyM ?? null,
    altitudeM: p.precise?.altitudeM ?? null,
    speedMps: p.precise?.speedMps ?? null,
    headingDeg: p.precise?.headingDeg ?? null,
    geohash: p.coarse?.geohash ?? null,
    city: p.coarse?.city ?? null,
    area: p.coarse?.area ?? null,
    coarsePlaceType: p.coarse?.placeType ?? null,
    motion: p.motion ?? null,
    batteryLevel: p.battery?.level ?? null,
    batteryCharging: p.battery?.charging ?? null,
    source: p.source,
    privacyMode: p.privacy.mode,
    allowPreciseToAgents: p.privacy.allowPreciseToAgents,
    currentPlaceName: p.currentPlaceName ?? null,
    staleEventFired: p.staleEventFired,
    updatedAt: p.updatedAt,
    receivedAt: p.receivedAt,
    staleAfterSec: p.staleAfterSec,
  };
}

/** Drop internal bookkeeping fields for external (API/MCP) consumers. */
export function toPresenceContext(stored: StoredPresence): PresenceContext {
  const { currentPlaceName: _c, staleEventFired: _s, ...ctx } = stored;
  return ctx;
}

export class PresenceStore {
  constructor(private readonly db: Database) {}

  /**
   * Readings across all users whose `became_stale` has not fired yet, for the
   * periodic sweep to age-check. Cross-user: system handle only.
   */
  async listUnfiredStale(): Promise<
    Array<{ userId: UserId; updatedAt: string; staleAfterSec: number }>
  > {
    const rows = (await this.db
      .select({
        userId: presence.userId,
        updatedAt: presence.updatedAt,
        staleAfterSec: presence.staleAfterSec,
      })
      .from(presence)
      .where(eq(presence.staleEventFired, false))) as Array<{
      userId: string;
      updatedAt: string;
      staleAfterSec: number;
    }>;
    return rows.map((r) => ({ ...r, userId: asUserId(r.userId) }));
  }

  async getCurrent(userId: UserId): Promise<StoredPresence | null> {
    const rows = (await this.db
      .select()
      .from(presence)
      .where(eq(presence.userId, userId))
      .limit(1)) as PresenceRow[];
    const row = rows[0];
    return row ? rowToStored(row) : null;
  }

  async upsert(p: StoredPresence): Promise<void> {
    const row = storedToRow(p);
    const { userId: _u, ...rest } = row;
    await this.db
      .insert(presence)
      .values(row)
      .onConflictDoUpdate({ target: presence.userId, set: rest });
  }

  /** Update only the stale-event flag (used when marking a reading stale). */
  async setStaleEventFired(userId: UserId, fired: boolean): Promise<void> {
    await this.db
      .update(presence)
      .set({ staleEventFired: fired })
      .where(eq(presence.userId, userId));
  }

  /**
   * Update only the privacy snapshot on the current row (used when the admin
   * changes settings) without disturbing the reading or its stale flag.
   */
  async setPrivacy(
    userId: UserId,
    mode: PrivacyMode,
    allowPreciseToAgents: boolean,
  ): Promise<void> {
    await this.db
      .update(presence)
      .set({ privacyMode: mode, allowPreciseToAgents })
      .where(eq(presence.userId, userId));
  }
}
