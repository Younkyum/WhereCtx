/**
 * Raw location history repository (plan section 9.4).
 * Disabled by default (STORE_RAW_HISTORY=false). When enabled, rows are pruned
 * past the retention window. Presence-first philosophy: this is opt-in.
 */

import { randomBytes } from "node:crypto";
import { and, asc, eq, gte, lt, lte } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { locationHistory } from "../db/schema.js";
import type { IngestSource, UserId } from "../types.js";
import { nowIso, type Clock, systemClock } from "../util/time.js";

export interface HistoryPoint {
  lat: number;
  lon: number;
  accuracyM?: number;
  source?: IngestSource;
  recordedAt: string;
}

interface HistoryRow {
  id: string;
  userId: string;
  lat: number;
  lon: number;
  accuracyM: number | null;
  source: string | null;
  recordedAt: string;
}

function rowToPoint(row: HistoryRow): HistoryPoint {
  return {
    lat: row.lat,
    lon: row.lon,
    accuracyM: row.accuracyM ?? undefined,
    source: (row.source as IngestSource | null) ?? undefined,
    recordedAt: row.recordedAt,
  };
}

export class HistoryStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  async append(userId: UserId, point: HistoryPoint): Promise<void> {
    await this.db.insert(locationHistory).values({
      id: randomBytes(16).toString("hex"),
      userId,
      lat: point.lat,
      lon: point.lon,
      accuracyM: point.accuracyM ?? null,
      source: point.source ?? null,
      recordedAt: point.recordedAt,
    });
  }

  /**
   * Points recorded in [from, to], oldest first, at most `limit`. `truncated`
   * says the range held more, so a caller can narrow it.
   */
  async listRange(
    userId: UserId,
    range: { from: string; to: string; limit: number },
  ): Promise<{ points: HistoryPoint[]; truncated: boolean }> {
    const rows = (await this.db
      .select()
      .from(locationHistory)
      .where(
        and(
          eq(locationHistory.userId, userId),
          gte(locationHistory.recordedAt, range.from),
          lte(locationHistory.recordedAt, range.to),
        ),
      )
      .orderBy(asc(locationHistory.recordedAt), asc(locationHistory.id))
      .limit(range.limit + 1)) as HistoryRow[];
    return { points: rows.slice(0, range.limit).map(rowToPoint), truncated: rows.length > range.limit };
  }

  /** Delete history older than `retentionHours` for a user. Returns rows removed. */
  async prune(userId: UserId, retentionHours: number): Promise<number> {
    const cutoff = new Date(
      this.clock().getTime() - retentionHours * 3600 * 1000,
    ).toISOString();
    const result = await this.db
      .delete(locationHistory)
      .where(
        and(eq(locationHistory.userId, userId), lt(locationHistory.recordedAt, cutoff)),
      );
    return result.rowsAffected ?? 0;
  }
}
