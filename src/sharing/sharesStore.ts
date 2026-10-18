/**
 * Location shares between people. The rules live in the SQL of each
 * statement, not in a prior read, so a membership change racing a request
 * cannot slip past them:
 *   - a share may be written only to someone who currently belongs to a
 *     common workspace with the owner, and never to oneself;
 *   - a share is read only while that is still true, so leaving the last
 *     common workspace ends visibility at once (the leave also deletes it,
 *     via `deleteOrphanedShares` in the membership batch);
 *   - each grant, change and revoke appends its audit event to the owner's
 *     log in the same batch as the write.
 */

import { and, eq, exists, ne, not, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Database } from "../db/index.js";
import { insertWhen } from "../db/insertWhen.js";
import { locationShares, users } from "../db/schema.js";
import type { EventsStore } from "../store/eventsStore.js";
import { shareAWorkspace } from "../accounts/roleSql.js";
import { asUserId, type PresenceEvent, type ShareLevel, type UserId } from "../types.js";
import { nowIso, type Clock, systemClock } from "../util/time.js";

export interface ShareGrant {
  level: ShareLevel;
  /** Omitted on an update: keep the current setting. */
  hideHomeExact?: boolean;
}

export interface Person {
  id: UserId;
  displayName: string;
}

export interface OutgoingShare {
  viewer: Person;
  level: ShareLevel;
  hideHomeExact: boolean;
}

export interface IncomingShare {
  owner: Person;
  level: ShareLevel;
  hideHomeExact: boolean;
}

/** A person's own precise-view audit is written at most this often per viewer. */
export const PRECISE_VIEW_AUDIT_INTERVAL_MS = 3600_000;

const counterpart = alias(users, "counterpart");

/** True for a share row whose two people still have a workspace in common. */
function stillCoMembers(): SQL {
  return shareAWorkspace(locationShares.ownerUserId, locationShares.viewerUserId);
}

/**
 * Delete every share of `userId`'s (either side) whose two people no longer
 * have a workspace in common. Placed after a membership removal in its batch.
 */
export function deleteOrphanedShares(db: Database, userId: UserId) {
  return db
    .delete(locationShares)
    .where(
      and(
        or(eq(locationShares.ownerUserId, userId), eq(locationShares.viewerUserId, userId)),
        not(stillCoMembers()),
      ),
    );
}

export class SharesStore {
  constructor(
    private readonly db: Database,
    private readonly events: EventsStore,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * Create or update `owner`'s share with `viewer`. Returns the audit events
   * written (none when nothing changed), or null when `viewer` is not a
   * current co-member (or is `owner`).
   */
  async put(owner: UserId, viewer: UserId, grant: ShareGrant): Promise<PresenceEvent[] | null> {
    const now = nowIso(this.clock);
    const eligible = and(
      eq(users.id, viewer),
      ne(users.id, owner),
      shareAWorkspace(owner, viewer),
    )!;
    const existing = this.existing(owner, viewer);
    const same = and(
      eq(locationShares.level, grant.level),
      grant.hideHomeExact === undefined ? undefined : eq(locationShares.hideHomeExact, grant.hideHomeExact),
    )!;
    const audit = { viewerUserId: viewer, level: grant.level };
    const granted = this.events.appendWhen(owner, { type: "share.granted", ...audit }, {
      from: users,
      where: and(eligible, not(existing))!,
    });
    const changed = this.events.appendWhen(owner, { type: "share.changed", ...audit }, {
      from: users,
      where: and(eligible, this.existing(owner, viewer, not(same)))!,
    });
    const upsert = insertWhen(
      this.db,
      locationShares,
      {
        ownerUserId: owner,
        viewerUserId: viewer,
        level: grant.level,
        hideHomeExact: grant.hideHomeExact ?? false,
        createdAt: now,
        updatedAt: now,
      },
      { from: users, where: eligible },
    ).onConflictDoUpdate({
      target: [locationShares.ownerUserId, locationShares.viewerUserId],
      set: {
        level: grant.level,
        ...(grant.hideHomeExact === undefined ? {} : { hideHomeExact: grant.hideHomeExact }),
        updatedAt: now,
      },
    });
    // The audit inserts read the share's state before the upsert changes it.
    const [grantedResult, changedResult, upserted] = await this.db.batch([
      granted.statement,
      changed.statement,
      upsert,
    ]);
    if (upserted.rowsAffected === 0) return null;
    return [
      ...(grantedResult.rowsAffected > 0 ? [granted.event] : []),
      ...(changedResult.rowsAffected > 0 ? [changed.event] : []),
    ];
  }

  /** Delete `owner`'s share with `viewer`; the revoke event, or null if there was none. */
  async revoke(owner: UserId, viewer: UserId): Promise<PresenceEvent | null> {
    const revoked = this.events.appendWhen(owner, { type: "share.revoked", viewerUserId: viewer }, {
      from: users,
      where: and(eq(users.id, owner), this.existing(owner, viewer))!,
    });
    const [, deleted] = await this.db.batch([
      revoked.statement,
      this.db
        .delete(locationShares)
        .where(and(eq(locationShares.ownerUserId, owner), eq(locationShares.viewerUserId, viewer))),
    ]);
    return deleted.rowsAffected > 0 ? revoked.event : null;
  }

  /** Whom `owner` currently shares with. */
  async listOutgoing(owner: UserId): Promise<OutgoingShare[]> {
    const rows = await this.db
      .select({
        id: counterpart.id,
        displayName: counterpart.displayName,
        level: locationShares.level,
        hideHomeExact: locationShares.hideHomeExact,
      })
      .from(locationShares)
      .innerJoin(counterpart, eq(counterpart.id, locationShares.viewerUserId))
      .where(and(eq(locationShares.ownerUserId, owner), stillCoMembers()))
      .orderBy(counterpart.displayName);
    return rows.map(({ id, displayName, ...share }) => ({
      viewer: { id: asUserId(id), displayName },
      ...share,
    }));
  }

  /** Who currently shares with `viewer`. */
  async listIncoming(viewer: UserId): Promise<IncomingShare[]> {
    const rows = await this.db
      .select({
        id: counterpart.id,
        displayName: counterpart.displayName,
        level: locationShares.level,
        hideHomeExact: locationShares.hideHomeExact,
      })
      .from(locationShares)
      .innerJoin(counterpart, eq(counterpart.id, locationShares.ownerUserId))
      .where(and(eq(locationShares.viewerUserId, viewer), stillCoMembers()))
      .orderBy(counterpart.displayName);
    return rows.map(({ id, displayName, ...share }) => ({
      owner: { id: asUserId(id), displayName },
      ...share,
    }));
  }

  /**
   * Note in `owner`'s log that `viewer` saw their precise location, unless
   * such a note is less than an hour old. Returns the event when written.
   */
  async recordPreciseView(owner: UserId, viewer: UserId): Promise<PresenceEvent | null> {
    const since = new Date(this.clock().getTime() - PRECISE_VIEW_AUDIT_INTERVAL_MS).toISOString();
    const viewed = this.events.appendWhen(
      owner,
      { type: "share.precise_viewed", viewerUserId: viewer },
      {
        from: users,
        where: and(
          eq(users.id, owner),
          not(this.events.recordedSince(owner, "share.precise_viewed", viewer, since)),
        )!,
      },
    );
    const result = await viewed.statement;
    return result.rowsAffected > 0 ? viewed.event : null;
  }

  /** True while `owner` has a share row for `viewer` (matching `extra`, if given). */
  private existing(owner: UserId, viewer: UserId, extra?: SQL): SQL {
    return exists(
      this.db
        .select({ one: sql`1` })
        .from(locationShares)
        .where(
          and(
            eq(locationShares.ownerUserId, owner),
            eq(locationShares.viewerUserId, viewer),
            extra,
          ),
        ),
    );
  }
}
