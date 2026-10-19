/**
 * Presence repository: maps the single current `presence` row to/from the
 * domain `PresenceContext`, plus internal fields the service needs but
 * agents never see: the dwell state (`currentPlaceName`, the confirmed place,
 * and the pending enter or leave), the approached places, and
 * `staleEventFired` (so `presence.became_stale` fires once per reading).
 */

import { eq, isNotNull, or } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { presence } from "../db/schema.js";
import type { LatLon } from "../geo/types.js";
import { NO_DWELL, type DwellState } from "../geofence/dwell.js";
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
  /** The confirmed place (dwell.ts `current`). */
  currentPlaceName?: string;
  /** Since when readings have been outside the confirmed place (its leave is pending). */
  pendingExitSince?: string;
  /** The place whose enter is pending, and since when. */
  pendingPlace?: { name: string; since: string };
  /** Places approaching fired for that have not re-armed (approach.ts). */
  approachedPlaces?: string[];
  staleEventFired: boolean;
  /** Where the person arrived at `movedAt` (freshness.ts `arrivalFor`). */
  movedFrom?: LatLon;
  /** The reading `coarse.city` and `coarse.area` were looked up for. */
  areaFor?: LatLon;
  /** Written for an older build rolled back onto this database; never read (see schema). */
  staleAfterSec: number;
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
  areaLat: number | null;
  areaLon: number | null;
  coarsePlaceType: CoarsePlaceType | null;
  motion: Motion | null;
  batteryLevel: number | null;
  batteryCharging: boolean | null;
  source: IngestSource;
  privacyMode: PrivacyMode;
  allowPreciseToAgents: boolean;
  currentPlaceName: string | null;
  pendingExitSince: string | null;
  pendingPlaceName: string | null;
  pendingPlaceSince: string | null;
  approachedPlaces: string[] | null;
  atOrNearHome: boolean;
  staleEventFired: boolean;
  updatedAt: string;
  receivedAt: string;
  movedAt: string | null;
  movedLat: number | null;
  movedLon: number | null;
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
    ...(row.movedAt ? { movedAt: row.movedAt } : {}),
    atOrNearHome: row.atOrNearHome,
    ...(row.movedLat !== null && row.movedLon !== null ? { movedFrom: { lat: row.movedLat, lon: row.movedLon } } : {}),
    ...(row.areaLat !== null && row.areaLon !== null ? { areaFor: { lat: row.areaLat, lon: row.areaLon } } : {}),
    staleAfterSec: row.staleAfterSec,
    currentPlaceName: row.currentPlaceName ?? undefined,
    ...(row.pendingExitSince ? { pendingExitSince: row.pendingExitSince } : {}),
    ...(row.pendingPlaceName && row.pendingPlaceSince
      ? { pendingPlace: { name: row.pendingPlaceName, since: row.pendingPlaceSince } }
      : {}),
    ...(row.approachedPlaces?.length ? { approachedPlaces: row.approachedPlaces } : {}),
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
    areaLat: p.areaFor?.lat ?? null,
    areaLon: p.areaFor?.lon ?? null,
    coarsePlaceType: p.coarse?.placeType ?? null,
    motion: p.motion ?? null,
    batteryLevel: p.battery?.level ?? null,
    batteryCharging: p.battery?.charging ?? null,
    source: p.source,
    privacyMode: p.privacy.mode,
    allowPreciseToAgents: p.privacy.allowPreciseToAgents,
    currentPlaceName: p.currentPlaceName ?? null,
    pendingExitSince: p.pendingExitSince ?? null,
    pendingPlaceName: p.pendingPlace?.name ?? null,
    pendingPlaceSince: p.pendingPlace?.since ?? null,
    approachedPlaces: p.approachedPlaces?.length ? p.approachedPlaces : null,
    atOrNearHome: p.atOrNearHome,
    staleEventFired: p.staleEventFired,
    updatedAt: p.updatedAt,
    receivedAt: p.receivedAt,
    movedAt: p.movedAt ?? null,
    movedLat: p.movedFrom?.lat ?? null,
    movedLon: p.movedFrom?.lon ?? null,
    staleAfterSec: p.staleAfterSec,
  };
}

/** Drop internal bookkeeping fields for external (API/MCP) consumers. */
export function toPresenceContext(stored: StoredPresence): PresenceContext {
  const {
    currentPlaceName: _c,
    pendingExitSince: _pe,
    pendingPlace: _pp,
    approachedPlaces: _ap,
    staleEventFired: _s,
    movedFrom: _m,
    areaFor: _a,
    staleAfterSec: _w,
    ...ctx
  } = stored;
  return ctx;
}

/** The dwell state a stored presence carries; none before the first reading. */
export function dwellOf(stored: StoredPresence | null): DwellState {
  if (!stored) return NO_DWELL;
  return {
    current: stored.currentPlaceName ?? null,
    exitSince: stored.pendingExitSince ?? null,
    candidate: stored.pendingPlace ?? null,
  };
}

/** The stored fields that hold `state`, every one set so a spread replaces the old ones. */
export function dwellFields(
  state: DwellState,
): Pick<StoredPresence, "currentPlaceName" | "pendingExitSince" | "pendingPlace"> {
  return {
    currentPlaceName: state.current ?? undefined,
    pendingExitSince: state.exitSince ?? undefined,
    pendingPlace: state.candidate ?? undefined,
  };
}

/** A `presence` row selected by another store's join, as a PresenceContext. */
export function presenceFromRow(row: typeof presence.$inferSelect): PresenceContext {
  return toPresenceContext(rowToStored(row as PresenceRow));
}

export class PresenceStore {
  constructor(private readonly db: Database) {}

  /**
   * Readings across all users whose `became_stale` has not fired yet, for the
   * periodic sweep to age-check. Cross-user: system handle only.
   */
  async listUnfiredStale(): Promise<Array<{ userId: UserId; source: IngestSource; receivedAt: string }>> {
    const rows = await this.db
      .select({ userId: presence.userId, source: presence.source, receivedAt: presence.receivedAt })
      .from(presence)
      .where(eq(presence.staleEventFired, false));
    return rows.map((r) => ({ ...r, userId: asUserId(r.userId) }));
  }

  /**
   * Users with an enter or a leave pending, for the periodic dwell sweep.
   * Cross-user: system handle only.
   */
  async listPendingDwell(): Promise<UserId[]> {
    const rows = await this.db
      .select({ userId: presence.userId })
      .from(presence)
      .where(or(isNotNull(presence.pendingExitSince), isNotNull(presence.pendingPlaceName)));
    return rows.map((r) => asUserId(r.userId));
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

  /** Update only the region names of the current reading and the point they are for (null clears them). */
  async setArea(userId: UserId, area: { city: string; area: string; forPoint: LatLon } | null): Promise<void> {
    await this.db
      .update(presence)
      .set({
        city: area?.city ?? null,
        area: area?.area ?? null,
        areaLat: area?.forPoint.lat ?? null,
        areaLon: area?.forPoint.lon ?? null,
      })
      .where(eq(presence.userId, userId));
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
