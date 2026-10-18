/**
 * The owner's record of agent reads (access_log). Writes and reads are
 * per user; only the prune sweep spans users.
 */

import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { newId } from "../auth/secrets.js";
import type { Database } from "../db/index.js";
import { accessLog } from "../db/schema.js";
import type { UserId } from "../types.js";
import { redactString } from "../util/log.js";
import { systemClock, type Clock } from "../util/time.js";
import { ACCESS_TEXT_MAX, type AccessEntry, type AccessRecord, type Page } from "./types.js";

export const ACCESS_PAGE_MAX = 200;

/** Identical requests this close together share one row, so a loop cannot flood the log. */
export const ACCESS_COALESCE_MS = 60_000;

/** Agent-supplied text (a reason) or a denial may quote a secret or coordinates, as an ingest rejection may. */
const clip = (text: string | undefined): string | null => (text ? redactString(text).slice(0, ACCESS_TEXT_MAX) : null);

/** A keyset cursor `createdAt|id`, so rows sharing a millisecond are neither skipped nor repeated. */
export function encodeCursor(createdAt: string, id: string): string {
  return `${createdAt}|${id}`;
}

export function decodeCursor(cursor: string | undefined): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  const bar = cursor.lastIndexOf("|");
  if (bar <= 0) return { createdAt: cursor, id: "" };
  return { createdAt: cursor.slice(0, bar), id: cursor.slice(bar + 1) };
}

export interface AccessQuery {
  limit?: number;
  before?: string;
  credentialId?: string;
}

export class AccessLogStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * Add a request to the log. One identical to a row from the last minute (same
   * credential, surface, action, outcome and denial) bumps that row's count
   * and last time instead; the row keeps its first reason.
   */
  async record(userId: UserId, entry: AccessRecord): Promise<void> {
    const now = this.clock();
    const at = now.toISOString();
    const denial = clip(entry.denial);
    const recent = this.db
      .select({ id: accessLog.id })
      .from(accessLog)
      .where(
        and(
          eq(accessLog.userId, userId),
          eq(accessLog.credentialId, entry.credential.id),
          eq(accessLog.surface, entry.surface),
          eq(accessLog.action, entry.action),
          eq(accessLog.outcome, entry.outcome),
          denial === null ? isNull(accessLog.denial) : eq(accessLog.denial, denial),
          gte(accessLog.lastAt, new Date(now.getTime() - ACCESS_COALESCE_MS).toISOString()),
        ),
      )
      .orderBy(desc(accessLog.lastAt))
      .limit(1);
    const bumped = await this.db
      .update(accessLog)
      .set({ count: sql`${accessLog.count} + 1`, lastAt: at })
      .where(inArray(accessLog.id, recent));
    if ((bumped.rowsAffected ?? 0) > 0) return;
    await this.db.insert(accessLog).values({
      id: newId(),
      userId,
      credentialKind: entry.credential.kind,
      credentialId: entry.credential.id,
      credentialName: entry.credential.name.slice(0, ACCESS_TEXT_MAX),
      surface: entry.surface,
      action: entry.action,
      precise: entry.precise,
      reason: clip(entry.reason),
      outcome: entry.outcome,
      denial,
      count: 1,
      createdAt: at,
      lastAt: at,
    });
  }

  /** Newest first. */
  async list(userId: UserId, query: AccessQuery = {}): Promise<Page<AccessEntry>> {
    const limit = Math.max(1, Math.min(query.limit ?? 50, ACCESS_PAGE_MAX));
    const cursor = decodeCursor(query.before);
    const rows = await this.db
      .select()
      .from(accessLog)
      .where(
        and(
          eq(accessLog.userId, userId),
          query.credentialId ? eq(accessLog.credentialId, query.credentialId) : undefined,
          cursor
            ? or(
                lt(accessLog.createdAt, cursor.createdAt),
                and(eq(accessLog.createdAt, cursor.createdAt), lt(accessLog.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(accessLog.createdAt), desc(accessLog.id))
      .limit(limit + 1);
    const entries: AccessEntry[] = rows.slice(0, limit).map((r) => ({
      id: r.id,
      credential: { kind: r.credentialKind, id: r.credentialId, name: r.credentialName },
      surface: r.surface,
      action: r.action,
      precise: r.precise,
      ...(r.reason ? { reason: r.reason } : {}),
      outcome: r.outcome,
      ...(r.denial ? { denial: r.denial } : {}),
      count: r.count,
      createdAt: r.createdAt,
      lastAt: r.lastAt,
    }));
    const last = entries.at(-1);
    return rows.length > limit && last ? { entries, next: encodeCursor(last.createdAt, last.id) } : { entries };
  }

  /** Every user's rows older than the retention window (prune sweep). */
  async prune(retentionDays: number): Promise<number> {
    const cutoff = new Date(this.clock().getTime() - retentionDays * 86_400_000).toISOString();
    const result = await this.db.delete(accessLog).where(lt(accessLog.createdAt, cutoff));
    return result.rowsAffected ?? 0;
  }
}
