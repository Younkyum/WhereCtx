/**
 * Presence events repository (plan section 9.8 / 10.3).
 * Append-only log of presence transitions, read back most-recent-first.
 */

import { randomBytes } from "node:crypto";
import { desc } from "drizzle-orm";
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
      .orderBy(desc(presenceEvents.createdAt))
      .limit(capped)) as EventRow[];
    return rows.map(rowToEvent);
  }
}
