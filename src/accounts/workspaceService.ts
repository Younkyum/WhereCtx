/**
 * Workspace operations, which span users: the one place they are decided.
 *
 * Every method takes the acting session first (routes reach them only through
 * the AccountScope that binds it) and checks the actor's membership and role
 * against the registry in ./types.ts. A workspace the actor does not belong to
 * answers `not_found`, never `forbidden`, so its existence is not revealed.
 * The stores re-check the same rules inside each write, so a role that changes
 * between this check and the write still cannot be exceeded.
 */

import type { WhereCtxConfig } from "../config.js";
import type { UserId } from "../types.js";
import { MAX_PENDING_INVITES, type InvitesStore } from "./invitesStore.js";
import {
  can,
  canManage,
  fail,
  ok,
  type Actor,
  type Invite,
  type Member,
  type Result,
  type Workspace,
  type WorkspaceAction,
  type WorkspaceId,
  type WorkspaceMembership,
  type WorkspaceRole,
} from "./types.js";
import { MAX_WORKSPACES, type MembershipWrite, type WorkspacesStore } from "./workspacesStore.js";

export interface WorkspaceStores {
  workspaces: WorkspacesStore;
  invites: InvitesStore;
}

const workspaceLimit = () => fail("conflict", `workspace limit reached (${MAX_WORKSPACES})`);

export class WorkspaceService {
  constructor(
    private readonly stores: WorkspaceStores,
    private readonly config: Pick<WhereCtxConfig, "baseUrl">,
  ) {}

  list(actor: Actor): Promise<WorkspaceMembership[]> {
    return this.stores.workspaces.listForUser(actor.userId);
  }

  async create(actor: Actor, name: string): Promise<Result<WorkspaceMembership>> {
    const created = await this.stores.workspaces.create(actor.userId, name);
    if (created === "limit") return workspaceLimit();
    if (created === "forbidden") {
      return fail("forbidden", "only workspace owners and admins may create workspaces");
    }
    return ok(created);
  }

  async rename(actor: Actor, id: WorkspaceId, name: string): Promise<Result<Workspace>> {
    const auth = await this.authorize(actor.userId, id, "rename");
    if (!auth.ok) return auth;
    const workspace = await this.stores.workspaces.rename(id, name);
    return workspace ? ok(workspace) : fail("not_found", "workspace not found");
  }

  async listMembers(actor: Actor, id: WorkspaceId): Promise<Result<Member[]>> {
    const auth = await this.authorize(actor.userId, id, "view");
    if (!auth.ok) return auth;
    return ok(await this.stores.workspaces.listMembers(id));
  }

  async changeRole(
    actor: Actor,
    id: WorkspaceId,
    target: UserId,
    role: WorkspaceRole,
  ): Promise<Result<void>> {
    const auth = await this.authorize(actor.userId, id, "changeRole");
    if (!auth.ok) return auth;
    const current = await this.stores.workspaces.roleOf(id, target);
    if (!current) return fail("not_found", "member not found");
    if (!canManage(auth.value, current) || !canManage(auth.value, role)) {
      return fail("forbidden", `a ${auth.value} cannot make a ${current} into a ${role}`);
    }
    return membershipResult(await this.stores.workspaces.setRole(id, actor.userId, target, role));
  }

  /** Remove a member, or leave when `target` is the actor. */
  async removeMember(actor: Actor, id: WorkspaceId, target: UserId): Promise<Result<void>> {
    if (target === actor.userId) {
      const auth = await this.authorize(actor.userId, id, "view");
      if (!auth.ok) return auth;
      return membershipResult(await this.stores.workspaces.leave(id, target));
    }
    const auth = await this.authorize(actor.userId, id, "removeMember");
    if (!auth.ok) return auth;
    const current = await this.stores.workspaces.roleOf(id, target);
    if (!current) return fail("not_found", "member not found");
    if (!canManage(auth.value, current)) {
      return fail("forbidden", `a ${auth.value} cannot remove a ${current}`);
    }
    return membershipResult(await this.stores.workspaces.remove(id, actor.userId, target));
  }

  // ---- invites ----

  async createInvite(
    actor: Actor,
    id: WorkspaceId,
    role: WorkspaceRole,
  ): Promise<Result<{ invite: Invite; url: string }>> {
    const auth = await this.authorize(actor.userId, id, "invite");
    if (!auth.ok) return auth;
    if (!canManage(auth.value, role)) {
      return fail("forbidden", `a ${auth.value} cannot invite a ${role}`);
    }
    const created = await this.stores.invites.create(id, role, actor.userId);
    if (created === "limit") {
      return fail("conflict", `pending invite limit reached (${MAX_PENDING_INVITES})`);
    }
    if (created === "forbidden") return fail("forbidden", `you cannot invite a ${role}`);
    const { invite, token } = created;
    return ok({ invite, url: `${this.config.baseUrl}/dashboard/#invite=${token}` });
  }

  async listInvites(actor: Actor, id: WorkspaceId): Promise<Result<Invite[]>> {
    const auth = await this.authorize(actor.userId, id, "invite");
    if (!auth.ok) return auth;
    return ok(await this.stores.invites.listPending(id));
  }

  async revokeInvite(actor: Actor, id: WorkspaceId, inviteId: string): Promise<Result<void>> {
    const auth = await this.authorize(actor.userId, id, "revokeInvite");
    if (!auth.ok) return auth;
    return (await this.stores.invites.revoke(id, inviteId))
      ? ok(undefined)
      : fail("not_found", "invite not found");
  }

  /** Join another workspace with an invite while signed in. */
  async acceptInvite(actor: Actor, token: string): Promise<Result<WorkspaceMembership>> {
    const redeemed = await this.stores.invites.redeemAsMember(token, actor.userId);
    if (redeemed.ok) return ok({ ...redeemed.workspace, role: redeemed.role });
    switch (redeemed.reason) {
      case "unknown":
        return fail("unauthorized", "invite not found");
      case "already_member":
        return fail("conflict", "you are already a member of this workspace");
      case "limit":
        return workspaceLimit();
      default:
        return fail("gone", `invite ${redeemed.reason}`);
    }
  }

  private async authorize(
    actor: UserId,
    id: WorkspaceId,
    action: WorkspaceAction,
  ): Promise<Result<WorkspaceRole>> {
    const role = await this.stores.workspaces.roleOf(id, actor);
    if (!role) return fail("not_found", "workspace not found");
    if (!can(role, action)) return fail("forbidden", `a ${role} cannot ${action}`);
    return ok(role);
  }
}

function membershipResult(outcome: MembershipWrite): Result<void> {
  switch (outcome) {
    case "ok":
      return ok(undefined);
    case "not_found":
      return fail("not_found", "member not found");
    case "forbidden":
      return fail("forbidden", "your role no longer allows this");
    case "last_owner":
      return fail("last_owner", "a workspace must keep at least one owner");
  }
}
