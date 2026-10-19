/**
 * Location shares between people, and the owner's audit of them. The rules
 * live in the SQL of each statement, not in a prior read, so a membership or
 * share change racing a request cannot slip past them:
 *   - a share may be written only to someone who currently belongs to a
 *     common workspace with the owner, and never to oneself;
 *   - without a fresh passkey proof, a write may only keep or lower what the
 *     viewer sees (no new share, no coarse -> precise, no unhiding home);
 *   - a share is read only while the two still have a workspace in common,
 *     in the same query that reads the owner's presence and settings. When
 *     the last common membership goes, a trigger (migration 0006) audits and
 *     deletes the share, whichever path removed the membership;
 *   - each grant, change and revoke appends its audit row in the same batch
 *     as the write, copying the share's state before the write changes it.
 */

import { and, desc, eq, exists, gt, lt, ne, not, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { randomBytes } from "node:crypto";
import type { Database } from "../db/index.js";
import { insertWhen } from "../db/insertWhen.js";
import {
  locationShares,
  places,
  presence,
  privacySettings,
  shareAudit,
  users,
} from "../db/schema.js";
import { shareAWorkspace } from "../accounts/roleSql.js";
import type { ShareTerms, SharingOwnerContext } from "../privacy/policy.js";
import { presenceFromRow } from "../store/presenceStore.js";
import {
  asUserId,
  type PresenceContext,
  type ShareAuditAction,
  type ShareAuditReason,
  type ShareLevel,
  type UserId,
} from "../types.js";
import { nowIso, type Clock, systemClock } from "../util/time.js";

export interface ShareGrant {
  level: ShareLevel;
  /** Omitted on an update: keep the current setting. */
  hideHomeExact?: boolean;
  /** Omitted on an update: keep the current setting. */
  showArea?: boolean;
}

export interface PutOptions {
  /** The owner proved their passkey recently, so the write may widen access. */
  mayWiden: boolean;
  /** hideHomeExact for a new share whose grant omits it. */
  defaultHideHomeExact: boolean;
  /** showArea for a new share whose grant omits it. */
  defaultShowArea: boolean;
}

export type PutOutcome = "ok" | "not_found" | "reauth_required";

export interface Person {
  id: UserId;
  displayName: string;
}

export interface OutgoingShare extends ShareTerms {
  viewer: Person;
}

export interface IncomingShare extends ShareTerms {
  owner: Person;
}

/** One share with everything a person view of its owner depends on. */
export interface VisibleShare {
  owner: Person;
  share: ShareTerms;
  ownerContext: SharingOwnerContext;
  presence: PresenceContext | null;
}

export interface ShareAuditEntry {
  id: string;
  viewer: { id: UserId; displayName: string | null };
  action: ShareAuditAction;
  reason: ShareAuditReason | null;
  before: ShareTerms | null;
  after: ShareTerms | null;
  createdAt: string;
}

/**
 * A precise view is audited at most this often per owner and viewer: the
 * audit says who looked and roughly when, not every refresh. A view exactly
 * one interval after the last audited one is audited again.
 */
export const PRECISE_VIEW_AUDIT_INTERVAL_MS = 3600_000;

const counterpart = alias(users, "counterpart");
const auditedViewer = alias(users, "audited_viewer");

/** True for a share row whose two people still have a workspace in common. */
function stillCoMembers(): SQL {
  return shareAWorkspace(locationShares.ownerUserId, locationShares.viewerUserId);
}

function auditId(): string {
  return randomBytes(16).toString("hex");
}

/** Audit rows written before show_area existed, and by the 0006 trigger, have none: it was off. */
function terms(level: ShareLevel | null, hideHomeExact: boolean | null, showArea: boolean | null): ShareTerms | null {
  return level === null || hideHomeExact === null ? null : { level, hideHomeExact, showArea: showArea ?? false };
}

export class SharesStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Create or update `owner`'s share with `viewer`. */
  async put(owner: UserId, viewer: UserId, grant: ShareGrant, options: PutOptions): Promise<PutOutcome> {
    const now = nowIso(this.clock);
    const eligible = and(eq(users.id, viewer), ne(users.id, owner), shareAWorkspace(owner, viewer))!;
    const thisShare = and(eq(locationShares.ownerUserId, owner), eq(locationShares.viewerUserId, viewer))!;
    const nextHide = grant.hideHomeExact ?? locationShares.hideHomeExact;
    const nextShow = grant.showArea ?? locationShares.showArea;
    // Evaluated against the current row: does this write show the viewer more?
    const widens = or(
      grant.level === "precise" ? eq(locationShares.level, "coarse") : undefined,
      grant.hideHomeExact === false ? eq(locationShares.hideHomeExact, true) : undefined,
      grant.showArea === true ? eq(locationShares.showArea, false) : undefined,
    );
    const allowed = options.mayWiden || !widens ? undefined : not(widens);
    const createHide = grant.hideHomeExact ?? options.defaultHideHomeExact;
    const createShow = grant.showArea ?? options.defaultShowArea;

    const granted = insertWhen(
      this.db,
      shareAudit,
      {
        id: auditId(),
        ownerUserId: owner,
        viewerUserId: viewer,
        action: "granted",
        reason: null,
        beforeLevel: null,
        afterLevel: grant.level,
        beforeHideHome: null,
        afterHideHome: createHide,
        beforeShowArea: null,
        afterShowArea: createShow,
        createdAt: now,
      },
      { from: users, where: and(eligible, not(this.exists(thisShare)))! },
    );
    const changed = insertWhen(
      this.db,
      shareAudit,
      {
        id: auditId(),
        ownerUserId: owner,
        viewerUserId: viewer,
        action: "changed",
        reason: null,
        beforeLevel: locationShares.level,
        afterLevel: grant.level,
        beforeHideHome: locationShares.hideHomeExact,
        afterHideHome: grant.hideHomeExact ?? locationShares.hideHomeExact,
        beforeShowArea: locationShares.showArea,
        afterShowArea: nextShow,
        createdAt: now,
      },
      {
        from: locationShares,
        where: and(
          thisShare,
          shareAWorkspace(owner, viewer),
          or(
            ne(locationShares.level, grant.level),
            ne(locationShares.hideHomeExact, nextHide),
            ne(locationShares.showArea, nextShow),
          ),
          allowed,
        )!,
      },
    );
    const upsert = insertWhen(
      this.db,
      locationShares,
      {
        ownerUserId: owner,
        viewerUserId: viewer,
        level: grant.level,
        hideHomeExact: createHide,
        showArea: createShow,
        createdAt: now,
        updatedAt: now,
      },
      // Without step-up the insert only reaches an existing row's update.
      { from: users, where: and(eligible, options.mayWiden ? undefined : this.exists(thisShare))! },
    ).onConflictDoUpdate({
      target: [locationShares.ownerUserId, locationShares.viewerUserId],
      set: {
        level: grant.level,
        ...(grant.hideHomeExact === undefined ? {} : { hideHomeExact: grant.hideHomeExact }),
        ...(grant.showArea === undefined ? {} : { showArea: grant.showArea }),
        updatedAt: now,
      },
      setWhere: allowed,
    });
    // The audit inserts read the share's state before the upsert changes it.
    const results = options.mayWiden
      ? await this.db.batch([granted, changed, upsert])
      : await this.db.batch([changed, upsert]);
    if (results[results.length - 1]!.rowsAffected > 0) return "ok";
    const stillEligible = await this.db.select({ id: users.id }).from(users).where(eligible).limit(1);
    return stillEligible.length > 0 ? "reauth_required" : "not_found";
  }

  /**
   * Delete `owner`'s share with `viewer`, auditing why (null: the owner
   * revoked it). False when there was no such share.
   */
  async revoke(owner: UserId, viewer: UserId, reason: ShareAuditReason | null): Promise<boolean> {
    const thisShare = and(eq(locationShares.ownerUserId, owner), eq(locationShares.viewerUserId, viewer))!;
    const audit = insertWhen(
      this.db,
      shareAudit,
      {
        id: auditId(),
        ownerUserId: owner,
        viewerUserId: viewer,
        action: "revoked",
        reason,
        beforeLevel: locationShares.level,
        afterLevel: null,
        beforeHideHome: locationShares.hideHomeExact,
        afterHideHome: null,
        beforeShowArea: locationShares.showArea,
        afterShowArea: null,
        createdAt: nowIso(this.clock),
      },
      { from: locationShares, where: thisShare },
    );
    const [, deleted] = await this.db.batch([audit, this.db.delete(locationShares).where(thisShare)]);
    return deleted.rowsAffected > 0;
  }

  /** Whom `owner` currently shares with. */
  async listOutgoing(owner: UserId): Promise<OutgoingShare[]> {
    const rows = await this.db
      .select({
        id: counterpart.id,
        displayName: counterpart.displayName,
        level: locationShares.level,
        hideHomeExact: locationShares.hideHomeExact,
        showArea: locationShares.showArea,
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

  /** Who currently shares with `viewer`, and on what terms. */
  async listIncoming(viewer: UserId): Promise<IncomingShare[]> {
    const rows = await this.db
      .select({
        id: counterpart.id,
        displayName: counterpart.displayName,
        level: locationShares.level,
        hideHomeExact: locationShares.hideHomeExact,
        showArea: locationShares.showArea,
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

  /** Whether any of `owner`'s shares shows their neighbourhood. */
  async showsAreaToAnyone(owner: UserId): Promise<boolean> {
    const rows = await this.db
      .select({ viewer: locationShares.viewerUserId })
      .from(locationShares)
      .where(and(eq(locationShares.ownerUserId, owner), eq(locationShares.showArea, true)))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * The shares `viewer` may see now (one owner's, when given), each with the
   * owner's current presence and sharing settings, in one query: the share
   * check and the presence read see the same database state.
   */
  async visibleTo(viewer: UserId, owner?: UserId): Promise<VisibleShare[]> {
    const rows = await this.db
      .select({
        id: counterpart.id,
        displayName: counterpart.displayName,
        level: locationShares.level,
        hideHomeExact: locationShares.hideHomeExact,
        showArea: locationShares.showArea,
        sharingPaused: privacySettings.sharingPaused,
        geoEnabled: privacySettings.geoEnabled,
        hasHomePlace: sql<number>`${exists(
          this.db
            .select({ one: sql`1` })
            .from(places)
            .where(and(eq(places.userId, locationShares.ownerUserId), eq(places.type, "home"))),
        )}`,
        presence,
      })
      .from(locationShares)
      .innerJoin(counterpart, eq(counterpart.id, locationShares.ownerUserId))
      .leftJoin(presence, eq(presence.userId, locationShares.ownerUserId))
      .leftJoin(privacySettings, eq(privacySettings.userId, locationShares.ownerUserId))
      .where(
        and(
          eq(locationShares.viewerUserId, viewer),
          owner === undefined ? undefined : eq(locationShares.ownerUserId, owner),
          stillCoMembers(),
        ),
      )
      .orderBy(counterpart.displayName);
    return rows.map((row) => ({
      owner: { id: asUserId(row.id), displayName: row.displayName },
      share: { level: row.level, hideHomeExact: row.hideHomeExact, showArea: row.showArea },
      // An owner who never opened their settings has the seeded defaults: not paused, maps off.
      ownerContext: {
        sharingPaused: row.sharingPaused ?? false,
        hasHomePlace: Boolean(row.hasHomePlace),
        geoEnabled: row.geoEnabled ?? false,
      },
      presence: row.presence ? presenceFromRow(row.presence) : null,
    }));
  }

  /**
   * Audit that `viewer` saw `owner`'s coordinates, unless a view of theirs was
   * audited less than PRECISE_VIEW_AUDIT_INTERVAL_MS ago. The throttle check
   * is part of the insert, so concurrent views write one row.
   */
  async recordPreciseView(owner: UserId, viewer: UserId): Promise<boolean> {
    const now = this.clock();
    const since = new Date(now.getTime() - PRECISE_VIEW_AUDIT_INTERVAL_MS).toISOString();
    const recent = this.db
      .select({ id: shareAudit.id })
      .from(shareAudit)
      .where(
        and(
          eq(shareAudit.ownerUserId, owner),
          eq(shareAudit.viewerUserId, viewer),
          eq(shareAudit.action, "precise_viewed"),
          gt(shareAudit.createdAt, since),
        ),
      );
    const result = await insertWhen(
      this.db,
      shareAudit,
      {
        id: auditId(),
        ownerUserId: owner,
        viewerUserId: viewer,
        action: "precise_viewed",
        reason: null,
        beforeLevel: null,
        afterLevel: null,
        beforeHideHome: null,
        afterHideHome: null,
        beforeShowArea: null,
        afterShowArea: null,
        createdAt: now.toISOString(),
      },
      { from: users, where: and(eq(users.id, owner), not(exists(recent)))! },
    );
    return result.rowsAffected > 0;
  }

  /** `owner`'s audit, newest first, with each viewer's current display name. */
  async listAudit(owner: UserId, limit: number): Promise<ShareAuditEntry[]> {
    const rows = await this.db
      .select({ audit: shareAudit, viewerName: auditedViewer.displayName })
      .from(shareAudit)
      .leftJoin(auditedViewer, eq(auditedViewer.id, shareAudit.viewerUserId))
      .where(eq(shareAudit.ownerUserId, owner))
      .orderBy(desc(shareAudit.createdAt), desc(shareAudit.id))
      .limit(limit);
    return rows.map(({ audit, viewerName }) => ({
      id: audit.id,
      viewer: { id: asUserId(audit.viewerUserId), displayName: viewerName },
      action: audit.action,
      reason: audit.reason,
      before: terms(audit.beforeLevel, audit.beforeHideHome, audit.beforeShowArea),
      after: terms(audit.afterLevel, audit.afterHideHome, audit.afterShowArea),
      createdAt: audit.createdAt,
    }));
  }

  /** Delete audit rows older than `retentionDays`. Returns rows removed. */
  async pruneAudit(retentionDays: number): Promise<number> {
    const cutoff = new Date(this.clock().getTime() - retentionDays * 86_400_000).toISOString();
    const result = await this.db.delete(shareAudit).where(lt(shareAudit.createdAt, cutoff));
    return result.rowsAffected;
  }

  private exists(where: SQL): SQL {
    return exists(this.db.select({ one: sql`1` }).from(locationShares).where(where));
  }
}
