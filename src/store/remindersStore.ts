/**
 * Location reminders repository (plan section 7.4 / MCP create_location_reminder).
 * A reminder fires when the user enters the named place; it is then marked
 * triggered. Minimal in v0.1 — no recurring rules.
 */

import { randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { reminders } from "../db/schema.js";
import { nowIso, type Clock, systemClock } from "../util/time.js";

export interface Reminder {
  id: string;
  placeName: string;
  message: string;
  active: boolean;
  createdAt: string;
  triggeredAt?: string;
}

interface ReminderRow {
  id: string;
  placeName: string;
  message: string;
  active: boolean;
  createdAt: string;
  triggeredAt: string | null;
}

function rowToReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    placeName: row.placeName,
    message: row.message,
    active: row.active,
    createdAt: row.createdAt,
    triggeredAt: row.triggeredAt ?? undefined,
  };
}

export class RemindersStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(placeName: string, message: string): Promise<Reminder> {
    const record: ReminderRow = {
      id: randomBytes(16).toString("hex"),
      placeName,
      message,
      active: true,
      createdAt: nowIso(this.clock),
      triggeredAt: null,
    };
    await this.db.insert(reminders).values(record);
    return rowToReminder(record);
  }

  async countActive(): Promise<number> {
    const rows = (await this.db
      .select({ c: sql<number>`count(*)` })
      .from(reminders)
      .where(eq(reminders.active, true))) as Array<{ c: number }>;
    return rows[0]?.c ?? 0;
  }

  async listActive(): Promise<Reminder[]> {
    const rows = (await this.db
      .select()
      .from(reminders)
      .where(eq(reminders.active, true))
      .orderBy(desc(reminders.createdAt))) as ReminderRow[];
    return rows.map(rowToReminder);
  }

  /** Active reminders attached to a specific place. */
  async listActiveForPlace(placeName: string): Promise<Reminder[]> {
    const rows = (await this.db
      .select()
      .from(reminders)
      .where(and(eq(reminders.active, true), eq(reminders.placeName, placeName)))) as ReminderRow[];
    return rows.map(rowToReminder);
  }

  async markTriggered(id: string): Promise<void> {
    await this.db
      .update(reminders)
      .set({ active: false, triggeredAt: nowIso(this.clock) })
      .where(eq(reminders.id, id));
  }
}
