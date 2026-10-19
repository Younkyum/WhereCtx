/**
 * Webhook subscriptions repository (plan section 9.8).
 * Each subscription has a target URL, a list of event types (or ["*"]), and an
 * optional shared secret used to sign deliveries (HMAC) in Phase 4, and an
 * optional auth header sent with each delivery. Both are credentials, never
 * returned to a client. The secret is sealed at rest when a key is configured;
 * an auth header exists only sealed, so without a key there are none.
 *
 * User-facing CRUD is scoped to the owning user. The dispatcher's `listActive`
 * and the boot-time secret hygiene helpers are deliberately cross-user; each
 * returned `Webhook` carries its `userId` so delivery reads only its owner's
 * events.
 */

import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { webhookDeliveries, webhooks } from "../db/schema.js";
import { asUserId, type PresenceEvent, type UserId } from "../types.js";
import { isEncryptedSecret, type SecretBox } from "../webhooks/secretBox.js";
import { authHeaderProblem, type WebhookAuthHeader } from "../webhooks/authHeader.js";
import { nowIso, type Clock, systemClock } from "../util/time.js";
import { log } from "../util/log.js";

/** Highest possible 16-byte hex id; used to seed a cursor "past" a timestamp. */
const MAX_ID = "f".repeat(32);

/** Encode a composite delivery cursor "(createdAt, eventId)" as a string. */
export function formatCursor(createdAt: string, eventId: string): string {
  return `${createdAt}|${eventId}`;
}

/** One spelling per selection: ["*"] when it includes "*" or is empty, otherwise each type once, in order. */
export function normalizeEvents(events: readonly string[]): string[] {
  if (events.length === 0 || events.includes("*")) return ["*"];
  return [...new Set(events)];
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
  authHeader?: WebhookAuthHeader;
  /**
   * The stored auth_header as read. Every write seals with a fresh IV, so it
   * changes whenever the header is replaced or removed: a drain holding an
   * old copy can tell. Internal; never serialized.
   */
  authHeaderSealed: string | null;
  active: boolean;
  /** ISO createdAt of the last event delivered to this hook (delivery cursor). */
  cursor?: string;
  createdAt: string;
}

/**
 * A hook whose stored credentials do not open. Its owner still sees it, so
 * they can delete it or replace its auth header; it is never delivered.
 */
export type UnreadableWebhook = Omit<Webhook, "secret" | "authHeader" | "authHeaderSealed"> & {
  credentialsUnreadable: true;
};

/** What the owner's list shows: a deliverable hook, or one whose credentials do not open. */
export type WebhookListing = Webhook | UnreadableWebhook;

/** Why a hook's credentials did not open. */
type Unreadable = "no_key" | "decrypt" | "plaintext" | "malformed";

const UNREADABLE_LOG: Record<Unreadable, string> = {
  no_key: "webhook credential is encrypted, or is an auth header, but WEBHOOK_ENCRYPTION_KEY is not set; skipping hook",
  decrypt: "webhook credential failed to decrypt (wrong WEBHOOK_ENCRYPTION_KEY?); skipping hook",
  plaintext: "webhook auth header is stored unencrypted; skipping hook until its auth header is replaced or removed",
  malformed: "webhook auth header opened but is not a valid header; skipping hook until it is replaced or removed",
};

type Opened<T> = { ok: true; value: T } | { ok: false; reason: Unreadable };

interface WebhookRow {
  id: string;
  userId: string;
  url: string;
  events: string[];
  secret: string | null;
  authHeader: string | null;
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

  /** The auth header is bound to its hook and owner: a sealed value copied to another row does not open. */
  private static authAad(row: Pick<WebhookRow, "id" | "userId">): string {
    return `webhook-auth|${row.userId}|${row.id}`;
  }

  /** Reported (hook id, reason) pairs, so a broken row is logged once, not on every tick. */
  private readonly reported = new Set<string>();

  /** Whether this store can take an auth header: only with a key, since one is never stored in the clear. */
  get sealsAuthHeaders(): boolean {
    return this.secretBox !== undefined;
  }

  private seal(plaintext: string, aad?: string): string {
    return this.secretBox ? this.secretBox.encrypt(plaintext, aad) : plaintext;
  }

  private openSecret(stored: string): Opened<string> {
    if (!this.secretBox) return isEncryptedSecret(stored) ? { ok: false, reason: "no_key" } : { ok: true, value: stored };
    try {
      return { ok: true, value: this.secretBox.decrypt(stored) };
    } catch {
      return { ok: false, reason: "decrypt" };
    }
  }

  private openAuthHeader(row: Pick<WebhookRow, "id" | "userId">, stored: string): Opened<WebhookAuthHeader> {
    if (!this.secretBox) return { ok: false, reason: "no_key" };
    if (!isEncryptedSecret(stored)) return { ok: false, reason: "plaintext" };
    let opened: string;
    try {
      opened = this.secretBox.decrypt(stored, WebhooksStore.authAad(row));
    } catch {
      return { ok: false, reason: "decrypt" };
    }
    try {
      const { name, value } = JSON.parse(opened) as Partial<WebhookAuthHeader>;
      if (typeof name === "string" && typeof value === "string" && authHeaderProblem(name, value) === null) {
        return { ok: true, value: { name, value } };
      }
    } catch {
      // Falls through to malformed.
    }
    return { ok: false, reason: "malformed" };
  }

  private sealAuthHeader(row: Pick<WebhookRow, "id" | "userId">, header: WebhookAuthHeader): string {
    if (!this.secretBox) throw new Error("auth headers need WEBHOOK_ENCRYPTION_KEY");
    return this.secretBox.encrypt(JSON.stringify({ name: header.name, value: header.value }), WebhooksStore.authAad(row));
  }

  private reportUnreadable(webhookId: string, reason: Unreadable): void {
    const key = `${webhookId}|${reason}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    log.error(UNREADABLE_LOG[reason], undefined, { webhookId });
  }

  /**
   * Map a row to the domain object, opening its credentials. A credential that
   * does not open (the key changed, no key is set, the row was copied, edited
   * or corrupted) fails closed for that hook alone: it is logged once and comes
   * back unreadable, so we never deliver with a wrong signature or without the
   * receiver's credential, and every other hook keeps delivering.
   */
  private readRow(row: WebhookRow): WebhookListing {
    const base = {
      id: row.id,
      userId: asUserId(row.userId),
      url: row.url,
      events: row.events,
      active: row.active,
      cursor: row.cursor ?? undefined,
      createdAt: row.createdAt,
    };
    const secret = row.secret === null ? null : this.openSecret(row.secret);
    const authHeader = row.authHeader === null ? null : this.openAuthHeader(row, row.authHeader);
    for (const opened of [secret, authHeader]) {
      if (opened && !opened.ok) {
        this.reportUnreadable(row.id, opened.reason);
        return { ...base, credentialsUnreadable: true };
      }
    }
    return {
      ...base,
      ...(secret?.ok ? { secret: secret.value } : {}),
      ...(authHeader?.ok ? { authHeader: authHeader.value } : {}),
      authHeaderSealed: row.authHeader,
    };
  }

  async create(
    userId: UserId,
    input: {
      url: string;
      events: string[];
      secret?: string;
      authHeader?: WebhookAuthHeader;
    },
  ): Promise<Webhook> {
    // Start the delivery cursor at "now" (with the max event id) so a new hook
    // receives future events only, not the entire historical backlog.
    const now = nowIso(this.clock);
    const id = randomBytes(16).toString("hex");
    const record: WebhookRow = {
      id,
      userId,
      url: input.url,
      events: normalizeEvents(input.events),
      secret: input.secret === undefined ? null : this.seal(input.secret),
      authHeader: input.authHeader ? this.sealAuthHeader({ id, userId }, input.authHeader) : null,
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
      authHeader: input.authHeader,
      authHeaderSealed: record.authHeader,
      active: record.active,
      cursor: record.cursor ?? undefined,
      createdAt: record.createdAt,
    };
  }

  private async credentialRows(): Promise<Array<Pick<WebhookRow, "id" | "userId" | "secret" | "authHeader">>> {
    return (await this.db
      .select({ id: webhooks.id, userId: webhooks.userId, secret: webhooks.secret, authHeader: webhooks.authHeader })
      .from(webhooks)
      .where(or(isNotNull(webhooks.secret), isNotNull(webhooks.authHeader)))) as Array<
      Pick<WebhookRow, "id" | "userId" | "secret" | "authHeader">
    >;
  }

  /**
   * One-time boot migration: when an encryption key is configured, re-encrypt
   * any legacy plaintext signing secrets in place. Idempotent; returns rows
   * updated. An auth header in the clear is not sealed here: it was never bound
   * to its hook, so it stays undeliverable until its owner replaces it.
   */
  async encryptLegacySecrets(): Promise<number> {
    if (!this.secretBox) return 0;
    let updated = 0;
    for (const row of await this.credentialRows()) {
      if (row.secret === null || isEncryptedSecret(row.secret)) continue;
      await this.db.update(webhooks).set({ secret: this.seal(row.secret) }).where(eq(webhooks.id, row.id));
      updated += 1;
    }
    return updated;
  }

  /** Whether any stored webhook has a plaintext signing secret, for the boot warning. */
  async hasPlaintextSecrets(): Promise<boolean> {
    return (await this.credentialRows()).some((r) => r.secret !== null && !isEncryptedSecret(r.secret));
  }

  /**
   * How many hooks have an auth header this store will never open by its form
   * alone: every one without a key, the unencrypted ones with a key. For the
   * boot warning; those hooks are not delivered.
   */
  async undeliverableAuthHeaders(): Promise<number> {
    return (await this.credentialRows()).filter(
      (r) => r.authHeader !== null && (!this.secretBox || !isEncryptedSecret(r.authHeader)),
    ).length;
  }

  /**
   * Advance a drain's hook to the composite cursor (createdAt, eventId), only
   * forward, only while the hook is active, and only while its event
   * selection and stored auth header are the ones the drain read. False means
   * the hook was paused, resumed (which moves the cursor to then),
   * re-subscribed, given another auth header or none, or rewound since, and
   * the drain must stop: its copy of the hook is stale.
   */
  async setCursor(
    hook: Pick<Webhook, "id" | "events" | "authHeaderSealed">,
    createdAt: string,
    eventId: string,
  ): Promise<boolean> {
    const cursor = formatCursor(createdAt, eventId);
    const result = await this.db
      .update(webhooks)
      .set({ cursor })
      .where(
        and(
          eq(webhooks.id, hook.id),
          eq(webhooks.active, true),
          eq(webhooks.events, hook.events),
          hook.authHeaderSealed === null ? isNull(webhooks.authHeader) : eq(webhooks.authHeader, hook.authHeaderSealed),
          or(isNull(webhooks.cursor), lt(webhooks.cursor, cursor)),
        ),
      );
    return (result.rowsAffected ?? 0) > 0;
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
    return rows.map((r) => this.readRow(r)).filter((w): w is Webhook => !("credentialsUnreadable" in w));
  }

  /** Every hook the user owns, those whose credentials do not open included, so they can be removed. */
  async list(userId: UserId): Promise<WebhookListing[]> {
    const rows = (await this.db
      .select()
      .from(webhooks)
      .where(eq(webhooks.userId, userId))) as WebhookRow[];
    return rows.map((r) => this.readRow(r));
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

  /**
   * Change an owned hook's event selection, pause it, or replace or remove
   * (null) its auth header. Turning a paused hook back on moves its cursor to
   * now, so it does not replay what happened while it was off. Returns the
   * hook as stored after the write (unreadable when its credentials still do
   * not open), or null when the user has no such hook.
   */
  async update(
    userId: UserId,
    id: string,
    patch: { events?: string[]; active?: boolean; authHeader?: WebhookAuthHeader | null },
  ): Promise<WebhookListing | null> {
    const owned = and(eq(webhooks.userId, userId), eq(webhooks.id, id));
    const fresh = formatCursor(nowIso(this.clock), MAX_ID);
    const result = await this.db
      .update(webhooks)
      .set({
        ...(patch.events ? { events: normalizeEvents(patch.events) } : {}),
        ...(patch.active === undefined ? {} : { active: patch.active }),
        ...(patch.authHeader === undefined
          ? {}
          : { authHeader: patch.authHeader === null ? null : this.sealAuthHeader({ id, userId }, patch.authHeader) }),
        // SET reads the row as it was, so this sees whether the hook was off.
        ...(patch.active
          ? { cursor: sql`CASE WHEN ${webhooks.active} THEN ${webhooks.cursor} ELSE ${fresh} END` }
          : {}),
      })
      .where(owned);
    if ((result.rowsAffected ?? 0) === 0) return null;
    const rows = (await this.db.select().from(webhooks).where(owned)) as WebhookRow[];
    return rows[0] ? this.readRow(rows[0]) : null;
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
