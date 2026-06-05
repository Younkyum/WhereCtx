/**
 * Presence events repository (plan section 9.8 / 10.3).
 * Append-only log of presence transitions, read back most-recent-first.
 */

import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, or } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { presenceEvents } from "../db/schema.js";
import type { PresenceEvent, PresenceEventType } from "../types.js";
import { nowIso, type Clock, systemClock } from "../util/time.js";

export interface NewPresenceEvent {
  type: PresenceEventType;
  placeName?: string;
  status?: string;
  source?: string;
}

interface EventRow {
  id: string;
  type: PresenceEventType;
  placeName: string | null;
  status: string | null;
  source: string | null;
  createdAt: string;
}

function rowToEvent(row: EventRow): PresenceEvent {
  return {
    id: row.id,
    type: row.type,
    placeName: row.placeName ?? undefined,
    status: row.status ?? undefined,
    source: row.source ?? undefined,
    createdAt: row.createdAt,
  };
}

export class EventsStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  async append(event: NewPresenceEvent): Promise<PresenceEvent> {
    const record: EventRow = {
      id: randomBytes(16).toString("hex"),
      type: event.type,
      placeName: event.placeName ?? null,
      status: event.status ?? null,
      source: event.source ?? null,
      createdAt: nowIso(this.clock),
    };
    await this.db.insert(presenceEvents).values(record);
    return rowToEvent(record);
  }

  async listRecent(limit = 50): Promise<PresenceEvent[]> {
    const capped = Math.max(1, Math.min(limit, 500));
    const rows = (await this.db
      .select()
      .from(presenceEvents)
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
  async listSince(cursor: string | null, limit = 100): Promise<PresenceEvent[]> {
    const capped = Math.max(1, Math.min(limit, 500));
    const base = this.db.select().from(presenceEvents).$dynamic();
    let q = base;
    if (cursor) {
      const sep = cursor.indexOf("|");
      const ts = sep === -1 ? cursor : cursor.slice(0, sep);
      const id = sep === -1 ? "" : cursor.slice(sep + 1);
      q = base.where(
        or(
          gt(presenceEvents.createdAt, ts),
          and(eq(presenceEvents.createdAt, ts), gt(presenceEvents.id, id)),
        ),
      );
    }
    const rows = (await q
      .orderBy(asc(presenceEvents.createdAt), asc(presenceEvents.id))
      .limit(capped)) as EventRow[];
    return rows.map(rowToEvent);
  }
}
