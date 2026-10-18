/**
 * Workspace invites. The link carries a 256-bit token; only its hash is stored.
 *
 * An invite is only as good as its creator's current standing: creating one,
 * and claiming one, both require that the creator holds a membership in the
 * workspace whose role may issue the invite's role (./roleSql.ts). An admin
 * who is removed or demoted cannot leave behind a stashed link that still works.
 *
 * Redeeming is one guarded UPDATE (the claim), and every row the redemption
 * creates (membership, and for a new person the user and their first passkey)
 * is inserted in the same batch, conditioned on that UPDATE having claimed the
 * invite for this user. Either all of it lands or none.
 */

import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { insertWhen } from "../db/insertWhen.js";
import { invites, memberships, workspaces } from "../db/schema.js";
import { hashToken, newId, newOpaqueSecret } from "../auth/secrets.js";
import { asUserId, type UserId } from "../types.js";
import { nowIso, type Clock, systemClock } from "../util/time.js";
import type { NewPasskey, PasskeysStore } from "./passkeysStore.js";
import { actorMay, inviteBackedByCreator } from "./roleSql.js";
import type { NewUser, UsersStore } from "./usersStore.js";
import type { WorkspacesStore } from "./workspacesStore.js";
import {
  asWorkspaceId,
  type Invite,
  type Workspace,
  type WorkspaceId,
  type WorkspaceRole,
} from "./types.js";

export const INVITE_TTL_MS = 7 * 24 * 3600_000;
/** Per-workspace cap on outstanding invites. */
export const MAX_PENDING_INVITES = 50;

/** `revoked`: the creator no longer holds a role that may issue this invite. */
export type InviteState = "valid" | "expired" | "used" | "revoked";

export interface InviteLookup {
  invite: Invite;
  workspace: Workspace;
  state: InviteState;
}

export type InviteCreate = { invite: Invite; token: string } | "forbidden" | "limit";

export type Redemption =
  | { ok: true; workspace: Workspace; role: WorkspaceRole }
  | { ok: false; reason: "unknown" | "already_member" | "limit" | Exclude<InviteState, "valid"> };

function rowToInvite(row: typeof invites.$inferSelect): Invite {
  return {
    id: row.id,
    workspaceId: asWorkspaceId(row.workspaceId),
    role: row.role,
    createdBy: asUserId(row.createdBy),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

export interface InviteStoreDeps {
  users: UsersStore;
  passkeys: PasskeysStore;
  workspaces: WorkspacesStore;
}

export class InvitesStore {
  constructor(
    private readonly db: Database,
    private readonly deps: InviteStoreDeps,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * Create an invite, if `createdBy` may still issue `role` and the workspace
   * is under its pending-invite cap; the plaintext token is returned once.
   */
  async create(
    workspaceId: WorkspaceId,
    role: WorkspaceRole,
    createdBy: UserId,
  ): Promise<InviteCreate> {
    const token = newOpaqueSecret();
    const now = this.clock();
    const row = {
      id: newId(),
      workspaceId,
      tokenHash: hashToken(token),
      role,
      createdBy,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + INVITE_TTL_MS).toISOString(),
      usedAt: null,
      usedBy: null,
    };
    const pending = sql`(SELECT count(*) FROM ${invites} WHERE ${and(
      eq(invites.workspaceId, workspaceId),
      isNull(invites.usedAt),
      gt(invites.expiresAt, row.createdAt),
    )})`;
    const result = await insertWhen(this.db, invites, row, {
      from: workspaces,
      where: and(
        eq(workspaces.id, workspaceId),
        actorMay(workspaceId, createdBy, "invite", [role]),
        sql`${pending} < ${MAX_PENDING_INVITES}`,
      )!,
    });
    if (result.rowsAffected > 0) return { invite: rowToInvite(row), token };
    return (await this.listPending(workspaceId)).length >= MAX_PENDING_INVITES ? "limit" : "forbidden";
  }

  /** Unused, unexpired invites of a workspace. */
  async listPending(workspaceId: WorkspaceId): Promise<Invite[]> {
    const rows = await this.db
      .select()
      .from(invites)
      .where(
        and(
          eq(invites.workspaceId, workspaceId),
          isNull(invites.usedAt),
          gt(invites.expiresAt, nowIso(this.clock)),
        ),
      )
      .orderBy(invites.createdAt);
    return rows.map(rowToInvite);
  }

  /** Revoking deletes the row, so the link becomes indistinguishable from a bogus one. */
  async revoke(workspaceId: WorkspaceId, inviteId: string): Promise<boolean> {
    const result = await this.db
      .delete(invites)
      .where(
        and(
          eq(invites.workspaceId, workspaceId),
          eq(invites.id, inviteId),
          isNull(invites.usedAt),
        ),
      );
    return result.rowsAffected > 0;
  }

  async lookup(token: string): Promise<InviteLookup | null> {
    const rows = await this.db
      .select({ invite: invites, workspace: workspaces, backed: inviteBackedByCreator() })
      .from(invites)
      .innerJoin(workspaces, eq(workspaces.id, invites.workspaceId))
      .where(eq(invites.tokenHash, hashToken(token)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const state: InviteState = row.invite.usedAt
      ? "used"
      : row.invite.expiresAt <= nowIso(this.clock)
        ? "expired"
        : row.backed
          ? "valid"
          : "revoked";
    return {
      invite: rowToInvite(row.invite),
      workspace: { ...row.workspace, id: asWorkspaceId(row.workspace.id) },
      state,
    };
  }

  /** Join the invite's workspace as an existing user. */
  async redeemAsMember(token: string, userId: UserId): Promise<Redemption> {
    const found = await this.lookup(token);
    if (!found) return { ok: false, reason: "unknown" };
    const hash = hashToken(token);
    const now = nowIso(this.clock);
    const [claim] = await this.db.batch([
      this.claim(hash, userId, now),
      this.membership(found, hash, userId, now),
    ]);
    return this.outcome(token, userId, claim.rowsAffected);
  }

  /** Create a new user with their first passkey and join the invite's workspace. */
  async redeemAsNewUser(token: string, user: NewUser, passkey: NewPasskey): Promise<Redemption> {
    const found = await this.lookup(token);
    if (!found) return { ok: false, reason: "unknown" };
    const hash = hashToken(token);
    const now = nowIso(this.clock);
    const claimed = { from: invites, where: this.claimedBy(hash, user.id, now) };
    const [claim] = await this.db.batch([
      this.claim(hash, user.id, now),
      this.deps.users.insertWhen(user, now, claimed),
      this.deps.passkeys.insertWhen(user.id, passkey, now, claimed),
      this.membership(found, hash, user.id, now),
    ]);
    return this.outcome(token, user.id, claim.rowsAffected);
  }

  /** Drop invites that expired more than `graceHours` ago. */
  async pruneExpired(graceHours: number): Promise<number> {
    const cutoff = new Date(this.clock().getTime() - graceHours * 3600_000).toISOString();
    const result = await this.db.delete(invites).where(lt(invites.expiresAt, cutoff));
    return result.rowsAffected;
  }

  /**
   * Mark the invite used by `userId`, unless it is spent or expired, its
   * creator no longer backs it, `userId` already belongs, or is at the cap.
   */
  private claim(hash: string, userId: UserId, now: string) {
    return this.db
      .update(invites)
      .set({ usedAt: now, usedBy: userId })
      .where(
        and(
          eq(invites.tokenHash, hash),
          isNull(invites.usedAt),
          gt(invites.expiresAt, now),
          inviteBackedByCreator(),
          sql`NOT EXISTS (SELECT 1 FROM ${memberships} WHERE ${memberships.workspaceId} = ${invites.workspaceId} AND ${memberships.userId} = ${userId})`,
          this.deps.workspaces.belowWorkspaceCap(userId),
        ),
      );
  }

  private claimedBy(hash: string, userId: UserId, now: string) {
    return and(eq(invites.tokenHash, hash), eq(invites.usedBy, userId), eq(invites.usedAt, now))!;
  }

  private membership(found: InviteLookup, hash: string, userId: UserId, now: string) {
    return this.deps.workspaces.membershipWhen(found.invite.workspaceId, userId, found.invite.role, now, {
      from: invites,
      where: this.claimedBy(hash, userId, now),
    });
  }

  private async outcome(token: string, userId: UserId, claimed: number): Promise<Redemption> {
    const found = await this.lookup(token);
    if (!found) return { ok: false, reason: "unknown" };
    if (claimed > 0) return { ok: true, workspace: found.workspace, role: found.invite.role };
    if (found.state !== "valid") return { ok: false, reason: found.state };
    if (await this.deps.workspaces.roleOf(found.invite.workspaceId, userId)) {
      return { ok: false, reason: "already_member" };
    }
    return { ok: false, reason: "limit" };
  }
}
