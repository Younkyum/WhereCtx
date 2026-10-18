/**
 * Stored WebAuthn credentials. A user always keeps at least one: the delete is
 * guarded in the same statement, so two concurrent deletes cannot strand the
 * account without a way to sign in.
 */

import { and, eq, gt, lt, notExists, sql } from "drizzle-orm";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import type { Database } from "../db/index.js";
import { insertWhen, type InsertCondition } from "../db/insertWhen.js";
import { passkeys, users } from "../db/schema.js";
import { asUserId, type UserId } from "../types.js";
import { nowIso, type Clock, systemClock } from "../util/time.js";
import type { PasskeyInfo } from "./types.js";

/** A verified credential ready to store; `publicKey` is base64url COSE. */
export interface NewPasskey {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: AuthenticatorTransportFuture[];
  name: string;
}

export interface StoredPasskey extends NewPasskey {
  userId: UserId;
}

export type PasskeyDelete = "ok" | "not_found" | "last_passkey";

function rowToInfo(row: typeof passkeys.$inferSelect): PasskeyInfo {
  return {
    id: row.credentialId,
    name: row.name,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt ?? undefined,
  };
}

export class PasskeysStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  async countAll(): Promise<number> {
    const rows = await this.db.select({ c: sql<number>`count(*)` }).from(passkeys);
    return rows[0]?.c ?? 0;
  }

  async get(credentialId: string): Promise<StoredPasskey | null> {
    const rows = await this.db
      .select()
      .from(passkeys)
      .where(eq(passkeys.credentialId, credentialId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      credentialId: row.credentialId,
      userId: asUserId(row.userId),
      publicKey: row.publicKey,
      counter: row.counter,
      transports: row.transports,
      name: row.name,
    };
  }

  async list(userId: UserId): Promise<PasskeyInfo[]> {
    const rows = await this.db
      .select()
      .from(passkeys)
      .where(eq(passkeys.userId, userId))
      .orderBy(passkeys.createdAt);
    return rows.map(rowToInfo);
  }

  async listIds(userId: UserId): Promise<string[]> {
    const rows = await this.db
      .select({ id: passkeys.credentialId })
      .from(passkeys)
      .where(eq(passkeys.userId, userId));
    return rows.map((r) => r.id);
  }

  /** The stored passkey, or null when the credential id is already registered. */
  async add(userId: UserId, passkey: NewPasskey): Promise<PasskeyInfo | null> {
    const rows = await this.db
      .insert(passkeys)
      .values({ ...passkey, userId, createdAt: nowIso(this.clock), lastUsedAt: null })
      .onConflictDoNothing()
      .returning();
    return rows[0] ? rowToInfo(rows[0]) : null;
  }

  /** A statement that stores `passkey` only when `when` matches (for batches). */
  insertWhen(userId: UserId, passkey: NewPasskey, now: string, when: InsertCondition) {
    return insertWhen(
      this.db,
      passkeys,
      { ...passkey, userId, createdAt: now, lastUsedAt: null },
      when,
    );
  }

  /**
   * Store the install's first passkey. Inserts only while the table is empty,
   * so a second setup ceremony racing the first cannot also claim the install.
   */
  async addFirst(userId: UserId, passkey: NewPasskey): Promise<boolean> {
    const result = await this.insertWhen(userId, passkey, nowIso(this.clock), {
      from: users,
      where: and(eq(users.id, userId), notExists(this.db.select().from(passkeys)))!,
    });
    return result.rowsAffected > 0;
  }

  /**
   * Record a successful assertion. A non-zero counter must still be ahead of
   * the stored one when written, so two assertions racing with the same
   * counter (a cloned authenticator) cannot both pass; false means refused.
   * Authenticators that do not count always report 0.
   */
  async recordUse(credentialId: string, counter: number): Promise<boolean> {
    const lastUsedAt = nowIso(this.clock);
    const id = eq(passkeys.credentialId, credentialId);
    const result =
      counter > 0
        ? await this.db
            .update(passkeys)
            .set({ counter, lastUsedAt })
            .where(and(id, lt(passkeys.counter, counter)))
        : await this.db
            .update(passkeys)
            .set({ lastUsedAt })
            .where(and(id, eq(passkeys.counter, 0)));
    return result.rowsAffected > 0;
  }

  async delete(userId: UserId, credentialId: string): Promise<PasskeyDelete> {
    const owned = and(eq(passkeys.userId, userId), eq(passkeys.credentialId, credentialId));
    const others = this.db
      .select({ c: sql<number>`count(*)` })
      .from(passkeys)
      .where(eq(passkeys.userId, userId));
    const result = await this.db.delete(passkeys).where(and(owned, gt(others, 1)));
    if (result.rowsAffected > 0) return "ok";
    const exists = await this.db.select({ id: passkeys.credentialId }).from(passkeys).where(owned);
    return exists.length > 0 ? "last_passkey" : "not_found";
  }
}
