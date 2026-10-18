/**
 * Workspaces and their memberships. WorkspaceService decides who may do what
 * from the role registry; every write here re-checks the decision inside the
 * same SQL statement, so a role that changed after the service read it cannot
 * slip through:
 *   - the actor's current role must still permit the action on the target's
 *     current role and on the role being granted (./roleSql.ts);
 *   - a workspace never loses its last owner;
 *   - creating a workspace respects the per-user cap and creator rule.
 * A membership change also drops the member's pending invites that their new
 * standing no longer backs, and a removal drops the location shares between
 * people who no longer have a workspace in common, in the same batch.
 */

import { and, eq, isNull, not, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { insertWhen, type InsertCondition } from "../db/insertWhen.js";
import { invites, memberships, users, workspaces } from "../db/schema.js";
import { asUserId, type UserId } from "../types.js";
import { nowIso, type Clock, systemClock } from "../util/time.js";
import { newId } from "../auth/secrets.js";
import { deleteOrphanedShares } from "../sharing/sharesStore.js";
import { actorMay, inviteBackedByCreator } from "./roleSql.js";
import {
  asWorkspaceId,
  WORKSPACE_CREATOR_ROLES,
  type Member,
  type Workspace,
  type WorkspaceId,
  type WorkspaceMembership,
  type WorkspaceRole,
} from "./types.js";

export const DEFAULT_WORKSPACE_NAME = "Default";
/** Per-user cap on workspaces joined or created. */
export const MAX_WORKSPACES = 20;

export type MembershipWrite = "ok" | "not_found" | "forbidden" | "last_owner";
export type WorkspaceCreate = WorkspaceMembership | "limit" | "forbidden";

export interface WorkspacesStoreOptions {
  /** ALLOW_MEMBER_WORKSPACES: anyone may create workspaces. */
  allowMemberWorkspaces: boolean;
  /** USER_ID, who may always create workspaces. */
  ownerId: UserId;
}

function rowToWorkspace(row: typeof workspaces.$inferSelect): Workspace {
  return { id: asWorkspaceId(row.id), name: row.name, createdAt: row.createdAt };
}

export class WorkspacesStore {
  constructor(
    private readonly db: Database,
    private readonly options: WorkspacesStoreOptions,
    private readonly clock: Clock = systemClock,
  ) {}

  /** True while `userId` is below the workspace cap. */
  belowWorkspaceCap(userId: UserId) {
    return sql`(SELECT count(*) FROM ${memberships} WHERE ${memberships.userId} = ${userId}) < ${MAX_WORKSPACES}`;
  }

  /** Create a workspace with `ownerId` as its owner, atomically and within the caps. */
  async create(ownerId: UserId, name: string): Promise<WorkspaceCreate> {
    const now = nowIso(this.clock);
    const id = asWorkspaceId(newId());
    const mayCreate = this.options.allowMemberWorkspaces
      ? sql`1`
      : or(
          eq(users.id, this.options.ownerId),
          sql`EXISTS (SELECT 1 FROM ${memberships} WHERE ${memberships.userId} = ${ownerId} AND ${memberships.role} IN (${sql.join(
            WORKSPACE_CREATOR_ROLES.map((r) => sql`${r}`),
            sql`, `,
          )}))`,
        );
    const [created] = await this.db.batch([
      insertWhen(this.db, workspaces, { id, name, createdAt: now }, {
        from: users,
        where: and(eq(users.id, ownerId), this.belowWorkspaceCap(ownerId), mayCreate)!,
      }),
      this.membershipWhen(id, ownerId, "owner", now, {
        from: workspaces,
        where: eq(workspaces.id, id),
      }),
    ]);
    if (created.rowsAffected > 0) return { id, name, createdAt: now, role: "owner" };
    return (await this.countForUser(ownerId)) >= MAX_WORKSPACES ? "limit" : "forbidden";
  }

  /** Give `userId` a Default workspace unless they already belong to one. */
  async ensureDefault(userId: UserId): Promise<void> {
    if ((await this.countForUser(userId)) > 0) return;
    await this.create(userId, DEFAULT_WORKSPACE_NAME);
  }

  /** A statement adding a membership only when `when` matches (for batches). */
  membershipWhen(
    workspaceId: WorkspaceId,
    userId: UserId,
    role: WorkspaceRole,
    now: string,
    when: InsertCondition,
  ) {
    return insertWhen(this.db, memberships, { workspaceId, userId, role, createdAt: now }, when)
      .onConflictDoNothing();
  }

  async get(id: WorkspaceId): Promise<Workspace | null> {
    const rows = await this.db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    return rows[0] ? rowToWorkspace(rows[0]) : null;
  }

  async rename(id: WorkspaceId, name: string): Promise<Workspace | null> {
    const rows = await this.db
      .update(workspaces)
      .set({ name })
      .where(eq(workspaces.id, id))
      .returning();
    return rows[0] ? rowToWorkspace(rows[0]) : null;
  }

  async listForUser(userId: UserId): Promise<WorkspaceMembership[]> {
    const rows = await this.db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        createdAt: workspaces.createdAt,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .where(eq(memberships.userId, userId))
      .orderBy(workspaces.createdAt);
    return rows.map((r) => ({ ...r, id: asWorkspaceId(r.id) }));
  }

  async countForUser(userId: UserId): Promise<number> {
    const rows = await this.db
      .select({ c: sql<number>`count(*)` })
      .from(memberships)
      .where(eq(memberships.userId, userId));
    return rows[0]?.c ?? 0;
  }

  async roleOf(id: WorkspaceId, userId: UserId): Promise<WorkspaceRole | null> {
    const rows = await this.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.workspaceId, id), eq(memberships.userId, userId)))
      .limit(1);
    return rows[0]?.role ?? null;
  }

  async listMembers(id: WorkspaceId): Promise<Member[]> {
    const rows = await this.db
      .select({
        userId: memberships.userId,
        displayName: users.displayName,
        role: memberships.role,
        joinedAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.workspaceId, id))
      .orderBy(memberships.createdAt);
    return rows.map((r) => ({ ...r, userId: asUserId(r.userId) }));
  }

  /** `actor` changes `target`'s role, if their current roles still allow it. */
  async setRole(
    id: WorkspaceId,
    actor: UserId,
    target: UserId,
    role: WorkspaceRole,
  ): Promise<MembershipWrite> {
    const allowed = actorMay(id, actor, "changeRole", [memberships.role, role]);
    const [result] = await this.db.batch([
      this.db
        .update(memberships)
        .set({ role })
        .where(
          and(
            this.member(id, target),
            allowed,
            role === "owner" ? undefined : this.keepsAnOwner(id),
          ),
        ),
      this.dropUnbackedInvites(id, target),
    ]);
    return this.outcome(id, target, allowed, result.rowsAffected);
  }

  /** `actor` removes `target`, if their current roles still allow it. */
  remove(id: WorkspaceId, actor: UserId, target: UserId): Promise<MembershipWrite> {
    return this.deleteMembership(id, target, actorMay(id, actor, "removeMember", [memberships.role]));
  }

  /** `userId` leaves; anyone may, except the last owner. */
  leave(id: WorkspaceId, userId: UserId): Promise<MembershipWrite> {
    return this.deleteMembership(id, userId, sql`1`);
  }

  private async deleteMembership(
    id: WorkspaceId,
    target: UserId,
    allowed: SQL,
  ): Promise<MembershipWrite> {
    const [result] = await this.db.batch([
      this.db
        .delete(memberships)
        .where(and(this.member(id, target), allowed, this.keepsAnOwner(id))),
      this.dropUnbackedInvites(id, target),
      deleteOrphanedShares(this.db, target),
    ]);
    return this.outcome(id, target, allowed, result.rowsAffected);
  }

  private member(id: WorkspaceId, userId: UserId) {
    return and(eq(memberships.workspaceId, id), eq(memberships.userId, userId));
  }

  /** True for the row being written unless it is the workspace's only owner. */
  private keepsAnOwner(id: WorkspaceId) {
    return sql`(${memberships.role} != 'owner' OR (SELECT count(*) FROM ${memberships} AS o WHERE o.workspace_id = ${id} AND o.role = 'owner') > 1)`;
  }

  /** Delete `creator`'s pending invites to `id` that their current role cannot issue. */
  private dropUnbackedInvites(id: WorkspaceId, creator: UserId) {
    return this.db
      .delete(invites)
      .where(
        and(
          eq(invites.workspaceId, id),
          eq(invites.createdBy, creator),
          isNull(invites.usedAt),
          not(inviteBackedByCreator()),
        ),
      );
  }

  /** Why a guarded write touched no row: no such member, no authority, or the owner guard. */
  private async outcome(
    id: WorkspaceId,
    target: UserId,
    allowed: SQL,
    rowsAffected: number,
  ): Promise<MembershipWrite> {
    if (rowsAffected > 0) return "ok";
    if (!(await this.roleOf(id, target))) return "not_found";
    const permitted = await this.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(and(this.member(id, target), allowed));
    return permitted.length > 0 ? "last_owner" : "forbidden";
  }
}
