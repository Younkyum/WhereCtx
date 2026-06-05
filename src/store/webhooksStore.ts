/**
 * Webhook subscriptions repository (plan section 9.8).
 * Each subscription has a target URL, a list of event types (or ["*"]), and an
 * optional shared secret used to sign deliveries (HMAC) in Phase 4.
 */

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { webhooks } from "../db/schema.js";
import { nowIso, type Clock, systemClock } from "../util/time.js";

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  secret?: string;
  active: boolean;
  createdAt: string;
}

interface WebhookRow {
  id: string;
  url: string;
  events: string[];
  secret: string | null;
  active: boolean;
  createdAt: string;
}

function rowToWebhook(row: WebhookRow): Webhook {
  return {
    id: row.id,
    url: row.url,
    events: row.events,
    secret: row.secret ?? undefined,
    active: row.active,
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
    const record: WebhookRow = {
      id: randomBytes(16).toString("hex"),
      url: input.url,
      events: input.events.length > 0 ? input.events : ["*"],
      secret: input.secret ?? null,
      active: true,
      createdAt: nowIso(this.clock),
    };
    await this.db.insert(webhooks).values(record);
    return rowToWebhook(record);
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
