/**
 * Presence events repository (plan section 9.8 / 10.3).
 * Append-only log of presence transitions, read back most-recent-first.
 * Every read and write is scoped to its owner; only retention pruning is global.
 */

import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, exists, gt, lt, or, type SQL } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { insertWhen, type InsertCondition } from "../db/insertWhen.js";
import { presenceEvents } from "../db/schema.js";
import {
  asUserId,
  type PresenceEvent,
  type PresenceEventType,
  type ShareLevel,
  type UserId,
} from "../types.js";
import { nowIso, type Clock, systemClock } from "../util/time.js";

export interface NewPresenceEvent {
  type: PresenceEventType;
  placeName?: string;
  status?: string;
  source?: string;
  viewerUserId?: UserId;
  level?: ShareLevel;
}

interface EventRow {
  id: string;
  userId: string;
  type: PresenceEventType;
  placeName: string | null;
  status: string | null;
  source: string | null;
  viewerUserId: string | null;
  shareLevel: ShareLevel | null;
  createdAt: string;
}

function rowToEvent(row: EventRow): PresenceEvent {
  return {
    id: row.id,
    type: row.type,
    placeName: row.placeName ?? undefined,
    status: row.status ?? undefined,
    source: row.source ?? undefined,
    viewerUserId: row.viewerUserId === null ? undefined : asUserId(row.viewerUserId),
    level: row.shareLevel ?? undefined,
    createdAt: row.createdAt,
  };
}

function newRow(userId: UserId, event: NewPresenceEvent, createdAt: string): EventRow {
  return {
    id: randomBytes(16).toString("hex"),
    userId,
    type: event.type,
    placeName: event.placeName ?? null,
    status: event.status ?? null,
    source: event.source ?? null,
    viewerUserId: event.viewerUserId ?? null,
    shareLevel: event.level ?? null,
    createdAt,
  };
}

export class EventsStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  async append(userId: UserId, event: NewPresenceEvent): Promise<PresenceEvent> {
    const [stored] = await this.appendMany(userId, [event]);
    return stored!;
  }

  /**
   * Append a batch of events with a single INSERT. The ingest hot path emits up
   * to 3 events per reading inside the per-user mutex; one round-trip instead
   * of N keeps the mutex hold time down on slow storage (review P1).
   */
  async appendMany(
    userId: UserId,
    events: NewPresenceEvent[],
  ): Promise<PresenceEvent[]> {
    if (events.length === 0) return [];
    const createdAt = nowIso(this.clock);
    const records = events.map((event) => newRow(userId, event, createdAt));
    await this.db.insert(presenceEvents).values(records);
    return records.map(rowToEvent);
  }

  /**
   * A statement appending `event` only when `when` matches (for batches),
   * plus the event it would write, so the caller can report it if it landed.
   */
  appendWhen(userId: UserId, event: NewPresenceEvent, when: InsertCondition) {
    const row = newRow(userId, event, nowIso(this.clock));
    return { statement: insertWhen(this.db, presenceEvents, row, when), event: rowToEvent(row) };
  }

  /** True while `userId` has an event of `type` about `viewer` newer than `since`. */
  recordedSince(userId: UserId, type: PresenceEventType, viewer: UserId, since: string): SQL {
    return exists(
      this.db
        .select({ id: presenceEvents.id })
        .from(presenceEvents)
        .where(
          and(
            eq(presenceEvents.userId, userId),
            eq(presenceEvents.type, type),
            eq(presenceEvents.viewerUserId, viewer),
            gt(presenceEvents.createdAt, since),
          ),
        ),
    );
  }

  /** Delete events older than the retention window. Returns rows removed. */
  async prune(retentionHours: number): Promise<number> {
    const cutoff = new Date(
      this.clock().getTime() - retentionHours * 3600 * 1000,
    ).toISOString();
    const result = await this.db
      .delete(presenceEvents)
      .where(lt(presenceEvents.createdAt, cutoff));
    return result.rowsAffected ?? 0;
  }

  async listRecent(userId: UserId, limit = 50): Promise<PresenceEvent[]> {
    const capped = Math.max(1, Math.min(limit, 500));
    const rows = (await this.db
      .select()
      .from(presenceEvents)
      .where(eq(presenceEvents.userId, userId))
      .orderBy(desc(presenceEvents.createdAt), desc(presenceEvents.id))
      .limit(capped)) as EventRow[];
    return rows.map(rowToEvent);
  }

  /**
   * Events after the composite cursor `"<createdAt>|<id>"`, oldest-first, for
   * webhook delivery. Uses a keyset predicate so events sharing a millisecond
   * createdAt are NOT skipped when the cursor lands mid-cluster (review H2):
   *   createdAt > ts  OR  (createdAt = ts AND id > id)
   * A null cursor returns the oldest events. A legacy cursor without an id part
   * is treated as `(ts, "")`, which re-includes that ms's events (safe:
   * at-least-once).
   */
  async listSince(
    userId: UserId,
    cursor: string | null,
    limit = 100,
  ): Promise<PresenceEvent[]> {
    const capped = Math.max(1, Math.min(limit, 500));
    const owner = eq(presenceEvents.userId, userId);
    let where = owner;
    if (cursor) {
      const sep = cursor.indexOf("|");
      const ts = sep === -1 ? cursor : cursor.slice(0, sep);
      const id = sep === -1 ? "" : cursor.slice(sep + 1);
      where = and(
        owner,
        or(
          gt(presenceEvents.createdAt, ts),
          and(eq(presenceEvents.createdAt, ts), gt(presenceEvents.id, id)),
        ),
      )!;
    }
    const rows = (await this.db
      .select()
      .from(presenceEvents)
      .where(where)
      .orderBy(asc(presenceEvents.createdAt), asc(presenceEvents.id))
      .limit(capped)) as EventRow[];
    return rows.map(rowToEvent);
  }
}
