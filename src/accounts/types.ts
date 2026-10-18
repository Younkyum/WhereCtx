/**
 * Account domain: users, workspaces, memberships and the role registry.
 *
 * A workspace groups people; every row of location data still belongs to one
 * user (phase 1 row-level isolation). Membership grants rights over the
 * workspace itself (name, members, invites), never over another member's data.
 */

import type { UserId } from "../types.js";

export type WorkspaceId = string & { readonly __brand: "WorkspaceId" };

export function asWorkspaceId(raw: string): WorkspaceId {
  if (raw.length === 0) throw new Error("workspaceId must be a non-empty string");
  return raw as WorkspaceId;
}

/** SHA-256 hex of a session cookie value; the public handle of a session. */
export type SessionId = string & { readonly __brand: "SessionId" };

export const WORKSPACE_ROLES = ["owner", "admin", "member"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export type WorkspaceAction =
  | "view"
  | "rename"
  | "invite"
  | "revokeInvite"
  | "changeRole"
  | "removeMember";

/** What each role may do to the workspace. */
export const ROLE_PERMISSIONS: Record<WorkspaceRole, ReadonlySet<WorkspaceAction>> = {
  owner: new Set(["view", "rename", "invite", "revokeInvite", "changeRole", "removeMember"]),
  admin: new Set(["view", "rename", "invite", "revokeInvite", "changeRole", "removeMember"]),
  member: new Set(["view"]),
};

/**
 * Roles a role may hand out or act on. An admin manages admins and members but
 * can neither create an owner nor touch one; only owners manage owners.
 */
export const MANAGEABLE_ROLES: Record<WorkspaceRole, ReadonlySet<WorkspaceRole>> = {
  owner: new Set(["owner", "admin", "member"]),
  admin: new Set(["admin", "member"]),
  member: new Set(),
};

export function can(role: WorkspaceRole, action: WorkspaceAction): boolean {
  return ROLE_PERMISSIONS[role].has(action);
}

export function canManage(actor: WorkspaceRole, target: WorkspaceRole): boolean {
  return MANAGEABLE_ROLES[actor].has(target);
}

/** Roles that may perform `action` on a member (or invite) holding `target`. */
export function rolesActingOn(target: WorkspaceRole, action: WorkspaceAction): WorkspaceRole[] {
  return WORKSPACE_ROLES.filter((actor) => can(actor, action) && canManage(actor, target));
}

/**
 * With ALLOW_MEMBER_WORKSPACES=false, only USER_ID and people who already hold
 * one of these roles somewhere may create a workspace.
 */
export const WORKSPACE_CREATOR_ROLES: readonly WorkspaceRole[] = ["owner", "admin"];

/** The signed-in person a request acts as, from their session. */
export interface Actor {
  userId: UserId;
  sessionId: SessionId;
  /** When this session last proved possession of a passkey (or code). */
  reauthAt: string;
}

/** How recent a passkey proof must be for sensitive account changes. */
export const REAUTH_WINDOW_MS = 10 * 60_000;

export function hasFreshAuth(reauthAt: string, now: Date): boolean {
  return now.getTime() - Date.parse(reauthAt) <= REAUTH_WINDOW_MS;
}

export interface User {
  id: UserId;
  displayName: string;
  createdAt: string;
}

export interface Workspace {
  id: WorkspaceId;
  name: string;
  createdAt: string;
}

export interface WorkspaceMembership extends Workspace {
  role: WorkspaceRole;
}

export interface Member {
  userId: UserId;
  displayName: string;
  role: WorkspaceRole;
  joinedAt: string;
}

export interface Invite {
  id: string;
  workspaceId: WorkspaceId;
  role: WorkspaceRole;
  createdBy: UserId;
  createdAt: string;
  expiresAt: string;
}

export interface PasskeyInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface SessionInfo {
  id: SessionId;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  userAgent?: string;
}

/** Why an account operation was refused; routes map each to one HTTP status. */
export type AccountErrorCode =
  | "invalid"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "last_owner"
  | "last_passkey"
  | "gone"
  | "reauth_required";

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; code: AccountErrorCode; message: string };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T = never>(code: AccountErrorCode, message: string): Result<T> {
  return { ok: false, code, message };
}
