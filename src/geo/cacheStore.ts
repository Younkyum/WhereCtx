/**
 * Reverse geocoding answers per person and provider, so standing still costs
 * no provider call. One person's cache never answers for another.
 *
 * A row is keyed by an HMAC of the rounded cell that was sent, under a
 * per-install key from server_secrets, so the table does not read as a list
 * of places someone was. (The key lives in the same database: this keeps the
 * rows from being read at a glance, not from someone holding the whole
 * database. The region names themselves are stored as they are.)
 *
 * A row lives for the shorter of seven days and the person's
 * retentionHours: it is ignored on read past that and pruned by the sweep.
 * Turning maps off or removing a key drops all of the person's rows
 * (`purge`).
 */

import { createHmac } from "node:crypto";
import { and, eq, gt, lt, or, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { geoCache, privacySettings } from "../db/schema.js";
import type { UserId } from "../types.js";
import { nowIso, systemClock, type Clock } from "../util/time.js";
import { roundPoint, type LatLon, type ReverseResult } from "./types.js";

export const GEO_CACHE_TTL_MS = 7 * 86_400_000;

/** How long a person's answers are kept: the shorter of seven days and their retentionHours. */
export function cacheTtlMs(retentionHours: number): number {
  return Math.min(GEO_CACHE_TTL_MS, Math.max(0, retentionHours) * 3_600_000);
}

export type CachedReverse = { hit: true; result: ReverseResult | null } | { hit: false };

export class GeoCacheStore {
  constructor(
    private readonly db: Database,
    /** The per-install key cells are keyed under. */
    private readonly key: string,
    private readonly clock: Clock = systemClock,
  ) {}

  /** The row key of a point: an HMAC of the rounded cell a provider would be sent. */
  cellOf(provider: string, point: LatLon): string {
    const cell = roundPoint(point);
    return createHmac("sha256", this.key).update(`${provider}|${cell.lat},${cell.lon}`).digest("base64url");
  }

  private since(ttlMs: number): string {
    return new Date(this.clock().getTime() - ttlMs).toISOString();
  }

  async get(userId: UserId, provider: string, point: LatLon, ttlMs: number): Promise<CachedReverse> {
    if (ttlMs <= 0) return { hit: false };
    const rows = await this.db
      .select({ result: geoCache.result })
      .from(geoCache)
      .where(
        and(
          eq(geoCache.userId, userId),
          eq(geoCache.provider, provider),
          eq(geoCache.cell, this.cellOf(provider, point)),
          gt(geoCache.createdAt, this.since(ttlMs)),
        ),
      )
      .limit(1);
    return rows[0] ? { hit: true, result: rows[0].result ?? null } : { hit: false };
  }

  async put(userId: UserId, provider: string, point: LatLon, result: ReverseResult | null, ttlMs: number): Promise<void> {
    if (ttlMs <= 0) return;
    const createdAt = nowIso(this.clock);
    const cell = this.cellOf(provider, point);
    await this.db
      .insert(geoCache)
      .values({ userId, provider, cell, result, createdAt })
      .onConflictDoUpdate({ target: [geoCache.userId, geoCache.provider, geoCache.cell], set: { result, createdAt } });
  }

  /** Drop every answer kept for the person. Returns rows removed. */
  async purge(userId: UserId): Promise<number> {
    const result = await this.db.delete(geoCache).where(eq(geoCache.userId, userId));
    return result.rowsAffected;
  }

  /** Remove every row past seven days or past its owner's retentionHours. Returns rows removed. */
  async prune(): Promise<number> {
    const now = nowIso(this.clock);
    const ownersCutoff = sql`(SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ${now}, '-' || ${privacySettings.retentionHours} || ' hours') FROM ${privacySettings} WHERE ${privacySettings.userId} = ${geoCache.userId})`;
    const result = await this.db
      .delete(geoCache)
      .where(or(lt(geoCache.createdAt, this.since(GEO_CACHE_TTL_MS)), lt(geoCache.createdAt, ownersCutoff)));
    return result.rowsAffected;
  }
}
