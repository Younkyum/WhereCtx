/**
 * Webhook subscriptions repository (plan section 9.8).
 * Each subscription has a target URL, a list of event types (or ["*"]), and an
 * optional shared secret used to sign deliveries (HMAC) in Phase 4.
 *
 * User-facing CRUD is scoped to the owning user. The dispatcher's `listActive`
 * and the boot-time secret hygiene helpers are deliberately cross-user; each
 * returned `Webhook` carries its `userId` so delivery reads only its owner's
 * events.
 */

import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { webhookDeliveries, webhooks } from "../db/schema.js";
import { asUserId, type PresenceEvent, type UserId } from "../types.js";
import { isEncryptedSecret, type SecretBox } from "../webhooks/secretBox.js";
import { nowIso, type Clock, systemClock } from "../util/time.js";
import { log } from "../util/log.js";

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
  userId: UserId;
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
  userId: string;
  url: string;
  events: string[];
  secret: string | null;
  active: boolean;
  cursor: string | null;
  createdAt: string;
}

export class WebhooksStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
    /** When present, signing secrets are encrypted at rest (review H2). */
    private readonly secretBox?: SecretBox,
  ) {}

  /**
   * Map a row to the domain object, decrypting the secret when needed. Returns
   * null (and logs loudly) when a stored secret cannot be decrypted — e.g. the
   * encryption key changed, or rows are encrypted but no key is configured.
   * Failing closed here means we never deliver with a wrong/garbage signature.
   */
  private rowToWebhook(row: WebhookRow): Webhook | null {
    let secret: string | undefined;
    if (row.secret !== null) {
      if (isEncryptedSecret(row.secret) && !this.secretBox) {
        log.error("webhook secret is encrypted but WEBHOOK_ENCRYPTION_KEY is not set; skipping hook", undefined, { webhookId: row.id });
        return null;
      }
      try {
        secret = this.secretBox ? this.secretBox.decrypt(row.secret) : row.secret;
      } catch {
        log.error("webhook secret failed to decrypt (wrong WEBHOOK_ENCRYPTION_KEY?); skipping hook", undefined, { webhookId: row.id });
        return null;
      }
    }
    return {
      id: row.id,
      userId: asUserId(row.userId),
      url: row.url,
      events: row.events,
      secret,
      active: row.active,
      cursor: row.cursor ?? undefined,
      createdAt: row.createdAt,
    };
  }

  async create(
    userId: UserId,
    input: {
      url: string;
      events: string[];
      secret?: string;
    },
  ): Promise<Webhook> {
    // Start the delivery cursor at "now" (with the max event id) so a new hook
    // receives future events only, not the entire historical backlog.
    const now = nowIso(this.clock);
    const record: WebhookRow = {
      id: randomBytes(16).toString("hex"),
      userId,
      url: input.url,
      events: input.events.length > 0 ? input.events : ["*"],
      secret:
        input.secret === undefined
          ? null
          : this.secretBox
            ? this.secretBox.encrypt(input.secret)
            : input.secret,
      active: true,
      cursor: formatCursor(now, MAX_ID),
      createdAt: now,
    };
    await this.db.insert(webhooks).values(record);
    // Deliberately returns the PLAINTEXT secret (not the stored ciphertext):
    // the creator needs it exactly once to configure the consumer. Callers must
    // never echo it back to clients after this point (the REST router strips it).
    return {
      id: record.id,
      userId,
      url: record.url,
      events: record.events,
      secret: input.secret,
      active: record.active,
      cursor: record.cursor ?? undefined,
      createdAt: record.createdAt,
    };
  }

  /**
   * One-time boot migration: when an encryption key is configured, re-encrypt
   * any legacy plaintext secrets in place. Idempotent; returns rows updated.
   */
  async encryptLegacySecrets(): Promise<number> {
    if (!this.secretBox) return 0;
    const rows = (await this.db
      .select({ id: webhooks.id, secret: webhooks.secret })
      .from(webhooks)
      .where(isNotNull(webhooks.secret))) as Array<{ id: string; secret: string }>;
    let updated = 0;
    for (const row of rows) {
      if (isEncryptedSecret(row.secret)) continue;
      await this.db
        .update(webhooks)
        .set({ secret: this.secretBox.encrypt(row.secret) })
        .where(eq(webhooks.id, row.id));
      updated += 1;
    }
    return updated;
  }

  /** Whether any stored webhook has a (plaintext) secret — used for the boot warning. */
  async hasPlaintextSecrets(): Promise<boolean> {
    const rows = (await this.db
      .select({ secret: webhooks.secret })
      .from(webhooks)
      .where(isNotNull(webhooks.secret))) as Array<{ secret: string }>;
    return rows.some((r) => !isEncryptedSecret(r.secret));
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

  /**
   * Dead letters for the caller's own hooks. `webhook_deliveries` has no owner
   * column, so ownership comes from the parent hook (deleting a hook deletes its
   * dead letters).
   */
  async listDeadLetters(userId: UserId, limit = 100): Promise<DeadLetter[]> {
    const capped = Math.max(1, Math.min(limit, 500));
    const rows = (await this.db
      .select({
        id: webhookDeliveries.id,
        webhookId: webhookDeliveries.webhookId,
        eventId: webhookDeliveries.eventId,
        eventType: webhookDeliveries.eventType,
        error: webhookDeliveries.error,
        createdAt: webhookDeliveries.createdAt,
      })
      .from(webhookDeliveries)
      .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
      .where(eq(webhooks.userId, userId))
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

  /** Every active hook across all users (dispatcher only). */
  async listActive(): Promise<Webhook[]> {
    const rows = (await this.db
      .select()
      .from(webhooks)
      .where(eq(webhooks.active, true))) as WebhookRow[];
    return rows
      .map((r) => this.rowToWebhook(r))
      .filter((w): w is Webhook => w !== null);
  }

  async list(userId: UserId): Promise<Webhook[]> {
    const rows = (await this.db
      .select()
      .from(webhooks)
      .where(eq(webhooks.userId, userId))) as WebhookRow[];
    return rows
      .map((r) => this.rowToWebhook(r))
      .filter((w): w is Webhook => w !== null);
  }

  /** Delete dead-letter rows older than the retention window. Returns rows removed. */
  async pruneDeadLetters(retentionHours: number): Promise<number> {
    const cutoff = new Date(
      this.clock().getTime() - retentionHours * 3600 * 1000,
    ).toISOString();
    const result = await this.db
      .delete(webhookDeliveries)
      .where(lt(webhookDeliveries.createdAt, cutoff));
    return result.rowsAffected ?? 0;
  }

  async count(userId: UserId): Promise<number> {
    const rows = (await this.db
      .select({ c: sql<number>`count(*)` })
      .from(webhooks)
      .where(eq(webhooks.userId, userId))) as Array<{ c: number }>;
    return rows[0]?.c ?? 0;
  }

  /** Delete an owned hook together with its dead letters, atomically. */
  async delete(userId: UserId, id: string): Promise<boolean> {
    const owned = and(eq(webhooks.userId, userId), eq(webhooks.id, id));
    const [, result] = await this.db.batch([
      this.db
        .delete(webhookDeliveries)
        .where(
          inArray(
            webhookDeliveries.webhookId,
            this.db.select({ id: webhooks.id }).from(webhooks).where(owned),
          ),
        ),
      this.db.delete(webhooks).where(owned),
    ]);
    return (result.rowsAffected ?? 0) > 0;
  }
}
