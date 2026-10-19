/**
 * The owner's record of device uploads (ingest_log): which credential sent,
 * on which route, and what became of it. Never the coordinates.
 */

import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { newId } from "../auth/secrets.js";
import type { Database } from "../db/index.js";
import { ingestLog, tokens } from "../db/schema.js";
import type { UserId } from "../types.js";
import { redactString } from "../util/log.js";
import { nowIso, systemClock, type Clock } from "../util/time.js";
import { decodeCursor, encodeCursor } from "./accessLogStore.js";
import {
  ACCESS_TEXT_MAX,
  type DeviceSummary,
  type IngestEntry,
  type IngestOutcome,
  type IngestRecord,
  type Page,
} from "./types.js";

export const INGEST_PAGE_MAX = 200;
const DAY_MS = 86_400_000;

export class IngestLogStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  async record(userId: UserId, entry: IngestRecord): Promise<void> {
    await this.db.insert(ingestLog).values({
      id: newId(),
      userId,
      tokenId: entry.token?.id ?? null,
      tokenName: entry.token?.name.slice(0, ACCESS_TEXT_MAX) ?? null,
      source: entry.source,
      outcome: entry.outcome,
      // A rejection message may quote the coordinates it refused.
      reason: entry.reason ? redactString(entry.reason).slice(0, ACCESS_TEXT_MAX) : null,
      receivedAt: nowIso(this.clock),
    });
  }

  /** Newest first. */
  async list(userId: UserId, query: { limit?: number; before?: string } = {}): Promise<Page<IngestEntry>> {
    const limit = Math.max(1, Math.min(query.limit ?? 50, INGEST_PAGE_MAX));
    const cursor = decodeCursor(query.before);
    const rows = await this.db
      .select()
      .from(ingestLog)
      .where(
        and(
          eq(ingestLog.userId, userId),
          cursor
            ? or(
                lt(ingestLog.receivedAt, cursor.createdAt),
                and(eq(ingestLog.receivedAt, cursor.createdAt), lt(ingestLog.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(ingestLog.receivedAt), desc(ingestLog.id))
      .limit(limit + 1);
    const entries: IngestEntry[] = rows.slice(0, limit).map((r) => ({
      id: r.id,
      token: r.tokenId ? { id: r.tokenId, name: r.tokenName ?? "" } : null,
      source: r.source,
      outcome: r.outcome,
      ...(r.reason ? { reason: r.reason } : {}),
      receivedAt: r.receivedAt,
    }));
    const last = entries.at(-1);
    return rows.length > limit && last ? { entries, next: encodeCursor(last.receivedAt, last.id) } : { entries };
  }

  /** Each of the user's device tokens with what it last sent and its last 24 hours. */
  async deviceSummaries(userId: UserId): Promise<DeviceSummary[]> {
    const since = new Date(this.clock().getTime() - DAY_MS).toISOString();
    const own = sql`${ingestLog.userId} = ${userId} AND ${ingestLog.tokenId} = ${tokens.id}`;
    const count = (outcome: IngestOutcome) =>
      sql<number>`(SELECT count(*) FROM ${ingestLog} WHERE ${own} AND ${ingestLog.outcome} = ${outcome} AND ${ingestLog.receivedAt} >= ${since})`;
    const rows = await this.db
      .select({
        id: tokens.id,
        name: tokens.name,
        createdAt: tokens.createdAt,
        lastUsedAt: tokens.lastUsedAt,
        lastReceivedAt: sql<string | null>`(SELECT max(${ingestLog.receivedAt}) FROM ${ingestLog} WHERE ${own})`,
        lastOutcome: sql<IngestOutcome | null>`(SELECT ${ingestLog.outcome} FROM ${ingestLog} WHERE ${own} ORDER BY ${ingestLog.receivedAt} DESC, ${ingestLog.id} DESC LIMIT 1)`,
        accepted24h: count("accepted"),
        rejected24h: count("rejected"),
      })
      .from(tokens)
      .where(and(eq(tokens.userId, userId), eq(tokens.role, "device")))
      .orderBy(tokens.createdAt);
    return rows.map((r) => ({
      ...r,
      accepted24h: Number(r.accepted24h),
      rejected24h: Number(r.rejected24h),
    }));
  }

  /** Every user's rows older than the retention window (prune sweep). */
  async prune(retentionDays: number): Promise<number> {
    const cutoff = new Date(this.clock().getTime() - retentionDays * DAY_MS).toISOString();
    const result = await this.db.delete(ingestLog).where(lt(ingestLog.receivedAt, cutoff));
    return result.rowsAffected ?? 0;
  }
}
