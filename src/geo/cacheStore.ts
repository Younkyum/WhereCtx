/**
 * Reverse geocoding answers per person and provider, keyed by the rounded
 * cell that was sent, so standing still costs no provider call. One person's
 * cache never answers for another. Rows older than the TTL are ignored on
 * read and pruned by the sweep.
 */

import { and, eq, gt, lt } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { geoCache } from "../db/schema.js";
import type { UserId } from "../types.js";
import { nowIso, systemClock, type Clock } from "../util/time.js";
import type { LatLon, ReverseResult } from "./types.js";

export const GEO_CACHE_TTL_MS = 7 * 86_400_000;

/** The cache key of a rounded point. */
export const cellOf = (point: LatLon): string => `${point.lat},${point.lon}`;

export type CachedReverse = { hit: true; result: ReverseResult | null } | { hit: false };

export class GeoCacheStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  private cutoff(): string {
    return new Date(this.clock().getTime() - GEO_CACHE_TTL_MS).toISOString();
  }

  async get(userId: UserId, provider: string, point: LatLon): Promise<CachedReverse> {
    const rows = await this.db
      .select({ result: geoCache.result })
      .from(geoCache)
      .where(
        and(
          eq(geoCache.userId, userId),
          eq(geoCache.provider, provider),
          eq(geoCache.cell, cellOf(point)),
          gt(geoCache.createdAt, this.cutoff()),
        ),
      )
      .limit(1);
    return rows[0] ? { hit: true, result: rows[0].result ?? null } : { hit: false };
  }

  async put(userId: UserId, provider: string, point: LatLon, result: ReverseResult | null): Promise<void> {
    const createdAt = nowIso(this.clock);
    await this.db
      .insert(geoCache)
      .values({ userId, provider, cell: cellOf(point), result, createdAt })
      .onConflictDoUpdate({ target: [geoCache.userId, geoCache.provider, geoCache.cell], set: { result, createdAt } });
  }

  /** Remove every row past the TTL. Returns rows removed. */
  async prune(): Promise<number> {
    const result = await this.db.delete(geoCache).where(lt(geoCache.createdAt, this.cutoff()));
    return result.rowsAffected;
  }
}
