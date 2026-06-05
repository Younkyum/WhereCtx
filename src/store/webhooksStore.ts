/**
 * Webhook subscriptions repository (plan section 9.8).
 * Each subscription has a target URL, a list of event types (or ["*"]), and an
 * optional shared secret used to sign deliveries (HMAC) in Phase 4.
 */

import { randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { webhookDeliveries, webhooks } from "../db/schema.js";
import type { PresenceEvent } from "../types.js";
import { nowIso, type Clock, systemClock } from "../util/time.js";

/** Highest possible 16-byte hex id; used to seed a cursor "past" a timestamp. */
const MAX_ID = "f".repeat(32);

/** Encode a composite delivery cursor "(createdAt, eventId)" as a string. */
export function formatCursor(createdAt: string, eventId: string): string {
  return `${createdAt}|${eventId}`;
}

export interface DeadLetter {
  id: string;
  webhookId: string;
  eventId: string;
  eventType: string;
  error?: string;
  createdAt: string;
}

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  secret?: string;
  active: boolean;
  /** ISO createdAt of the last event delivered to this hook (delivery cursor). */
  cursor?: string;
  createdAt: string;
}

interface WebhookRow {
  id: string;
  url: string;
  events: string[];
  secret: string | null;
  active: boolean;
  cursor: string | null;
  createdAt: string;
}

function rowToWebhook(row: WebhookRow): Webhook {
  return {
    id: row.id,
    url: row.url,
    events: row.events,
    secret: row.secret ?? undefined,
    active: row.active,
    cursor: row.cursor ?? undefined,
    createdAt: row.createdAt,
  };
}

export class WebhooksStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    url: string;
    events: string[];
    secret?: string;
  }): Promise<Webhook> {
    // Start the delivery cursor at "now" (with the max event id) so a new hook
    // receives future events only, not the entire historical backlog.
    const now = nowIso(this.clock);
    const record: WebhookRow = {
      id: randomBytes(16).toString("hex"),
      url: input.url,
      events: input.events.length > 0 ? input.events : ["*"],
      secret: input.secret ?? null,
      active: true,
      cursor: formatCursor(now, MAX_ID),
      createdAt: now,
    };
    await this.db.insert(webhooks).values(record);
    return rowToWebhook(record);
  }

  /** Advance a hook's delivery cursor to the composite (createdAt, eventId). */
  async setCursor(id: string, createdAt: string, eventId: string): Promise<void> {
    await this.db
      .update(webhooks)
      .set({ cursor: formatCursor(createdAt, eventId) })
      .where(eq(webhooks.id, id));
  }

  /** Record an event that was permanently undeliverable (dead-letter). */
  async recordDeadLetter(
    webhookId: string,
    event: PresenceEvent,
    error: string,
  ): Promise<void> {
    await this.db.insert(webhookDeliveries).values({
      id: randomBytes(16).toString("hex"),
      webhookId,
      eventId: event.id,
      eventType: event.type,
      error: error.slice(0, 500),
      createdAt: nowIso(this.clock),
    });
  }

  async listDeadLetters(limit = 100): Promise<DeadLetter[]> {
    const capped = Math.max(1, Math.min(limit, 500));
    const rows = (await this.db
      .select()
      .from(webhookDeliveries)
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(capped)) as Array<{
      id: string;
      webhookId: string;
      eventId: string;
      eventType: string;
      error: string | null;
      createdAt: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      webhookId: r.webhookId,
      eventId: r.eventId,
      eventType: r.eventType,
      error: r.error ?? undefined,
      createdAt: r.createdAt,
    }));
  }

  async listActive(): Promise<Webhook[]> {
    const rows = (await this.db
      .select()
      .from(webhooks)
      .where(eq(webhooks.active, true))) as WebhookRow[];
    return rows.map(rowToWebhook);
  }

  async list(): Promise<Webhook[]> {
    const rows = (await this.db.select().from(webhooks)) as WebhookRow[];
    return rows.map(rowToWebhook);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.delete(webhooks).where(eq(webhooks.id, id));
    return (result.rowsAffected ?? 0) > 0;
  }
}
