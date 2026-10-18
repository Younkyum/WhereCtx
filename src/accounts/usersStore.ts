/**
 * User accounts. A user id is the tenant key every user-data table stores in
 * `user_id`; ids minted here are random, while the install's first user keeps
 * the USER_ID it has always had.
 */

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { insertWhen, type InsertCondition } from "../db/insertWhen.js";
import { users } from "../db/schema.js";
import { asUserId, type UserId } from "../types.js";
import { nowIso, type Clock, systemClock } from "../util/time.js";
import type { User } from "./types.js";

export interface NewUser {
  id: UserId;
  displayName: string;
  webauthnHandle: string;
}

/** What an authenticator stores for an account: an opaque handle and a label. */
export interface RegistrationSubject {
  handle: string;
  name: string;
}

export function newWebauthnHandle(): string {
  return randomBytes(32).toString("hex");
}

function rowToUser(row: typeof users.$inferSelect): User {
  return { id: asUserId(row.id), displayName: row.displayName, createdAt: row.createdAt };
}

export class UsersStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  async get(userId: UserId): Promise<User | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  async registrationSubject(userId: UserId): Promise<RegistrationSubject | null> {
    const rows = await this.db
      .select({ handle: users.webauthnHandle, name: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Insert `userId` if absent; an existing row (and its name) is kept. */
  async ensure(userId: UserId, displayName: string): Promise<void> {
    await this.db
      .insert(users)
      .values({
        id: userId,
        displayName,
        webauthnHandle: newWebauthnHandle(),
        createdAt: nowIso(this.clock),
      })
      .onConflictDoNothing();
  }

  /** A statement that creates `user` only when `when` matches (for batches). */
  insertWhen(user: NewUser, now: string, when: InsertCondition) {
    return insertWhen(this.db, users, { ...user, createdAt: now }, when);
  }

  async rename(userId: UserId, displayName: string): Promise<User | null> {
    const rows = await this.db
      .update(users)
      .set({ displayName })
      .where(eq(users.id, userId))
      .returning();
    return rows[0] ? rowToUser(rows[0]) : null;
  }
}
