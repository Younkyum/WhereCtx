/**
 * Browser sessions. The cookie holds 32 random bytes; the table holds only
 * their hash, which doubles as the session's public id (listing, revoking).
 *
 * Expiry slides: a session seen again more than a day after its last refresh
 * gets a fresh 30-day window, but never past 90 days from sign-in, after which
 * the person signs in again. Refreshing at most daily keeps verification
 * read-mostly, like token lastUsedAt.
 *
 * `reauth_at` is the last time this session proved a passkey (sign-in counts);
 * sensitive account changes require it to be recent (types.ts hasFreshAuth).
 */

import { and, eq, lt, ne, or } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { sessions } from "../db/schema.js";
import { hashToken, newOpaqueSecret, OPAQUE_SECRET_PATTERN } from "../auth/secrets.js";
import { asUserId, type UserId } from "../types.js";
import { type Clock, systemClock } from "../util/time.js";
import type { SessionId, SessionInfo } from "./types.js";

export const SESSION_TTL_MS = 30 * 24 * 3600_000;
export const SESSION_MAX_AGE_MS = 90 * 24 * 3600_000;
const REFRESH_AFTER_MS = 24 * 3600_000;
const MAX_USER_AGENT = 256;

export interface VerifiedSession {
  userId: UserId;
  sessionId: SessionId;
  reauthAt: string;
  /** The expiry moved forward, so the cookie should be re-sent. */
  renewed: boolean;
}

function rowToInfo(row: typeof sessions.$inferSelect): SessionInfo {
  return {
    id: row.idHash as SessionId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastSeenAt: row.lastSeenAt,
    userAgent: row.userAgent ?? undefined,
  };
}

/** The sliding expiry, capped at the session's absolute end. */
function expiryFrom(now: Date, createdAt: string): string {
  const cap = Date.parse(createdAt) + SESSION_MAX_AGE_MS;
  return new Date(Math.min(now.getTime() + SESSION_TTL_MS, cap)).toISOString();
}

export class SessionsStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Start a freshly authenticated session; returns the cookie value, shown to the client only. */
  async create(userId: UserId, userAgent?: string): Promise<{ secret: string; id: SessionId }> {
    const secret = newOpaqueSecret();
    const now = this.clock();
    const idHash = hashToken(secret);
    await this.db.insert(sessions).values({
      idHash,
      userId,
      createdAt: now.toISOString(),
      expiresAt: expiryFrom(now, now.toISOString()),
      lastSeenAt: now.toISOString(),
      reauthAt: now.toISOString(),
      userAgent: userAgent?.slice(0, MAX_USER_AGENT) ?? null,
    });
    return { secret, id: idHash as SessionId };
  }

  async verify(secret: string | undefined): Promise<VerifiedSession | null> {
    if (!secret || !OPAQUE_SECRET_PATTERN.test(secret)) return null;
    const idHash = hashToken(secret);
    const rows = await this.db.select().from(sessions).where(eq(sessions.idHash, idHash)).limit(1);
    const row = rows[0];
    if (!row) return null;

    const now = this.clock();
    if (Date.parse(row.expiresAt) <= now.getTime()) {
      await this.db.delete(sessions).where(eq(sessions.idHash, idHash));
      return null;
    }
    const expiresAt = expiryFrom(now, row.createdAt);
    const renewed =
      now.getTime() - Date.parse(row.lastSeenAt) > REFRESH_AFTER_MS && expiresAt > row.expiresAt;
    if (renewed) {
      await this.db
        .update(sessions)
        .set({ lastSeenAt: now.toISOString(), expiresAt })
        .where(eq(sessions.idHash, idHash));
    }
    return {
      userId: asUserId(row.userId),
      sessionId: idHash as SessionId,
      reauthAt: row.reauthAt,
      renewed,
    };
  }

  /** Mark the session as having just proved a passkey. */
  async markReauthenticated(userId: UserId, id: SessionId): Promise<void> {
    await this.db
      .update(sessions)
      .set({ reauthAt: this.clock().toISOString() })
      .where(and(eq(sessions.userId, userId), eq(sessions.idHash, id)));
  }

  async list(userId: UserId): Promise<SessionInfo[]> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .orderBy(sessions.createdAt);
    const now = this.clock().getTime();
    return rows.filter((r) => Date.parse(r.expiresAt) > now).map(rowToInfo);
  }

  async revoke(userId: UserId, id: SessionId): Promise<boolean> {
    const result = await this.db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.idHash, id)));
    return result.rowsAffected > 0;
  }

  /** End every session of `userId` except `keep`; returns how many ended. */
  async revokeOthers(userId: UserId, keep: SessionId): Promise<number> {
    const result = await this.db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), ne(sessions.idHash, keep)));
    return result.rowsAffected;
  }

  /** Logout, or a new sign-in replacing it: end the session the cookie names. */
  async revokeSecret(secret: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.idHash, hashToken(secret)));
  }

  async prune(): Promise<number> {
    const now = this.clock();
    const result = await this.db
      .delete(sessions)
      .where(
        or(
          lt(sessions.expiresAt, now.toISOString()),
          lt(sessions.createdAt, new Date(now.getTime() - SESSION_MAX_AGE_MS).toISOString()),
        ),
      );
    return result.rowsAffected;
  }
}
