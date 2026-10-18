/**
 * The role registry (./types.ts) rendered as SQL, so the stores can re-check
 * authority inside the same statement as the write. A service reads the
 * actor's role before deciding; these predicates make the write itself refuse
 * when that role changed in between (a demotion racing an action).
 */

import { and, eq, exists, sql, type SQL } from "drizzle-orm";
import { alias, QueryBuilder, type SQLiteColumn } from "drizzle-orm/sqlite-core";
import { invites, memberships } from "../db/schema.js";
import type { UserId } from "../types.js";
import {
  rolesActingOn,
  WORKSPACE_ROLES,
  type WorkspaceAction,
  type WorkspaceId,
  type WorkspaceRole,
} from "./types.js";

type RoleExpr = SQLiteColumn | SQL | WorkspaceRole;

function inList(expr: SQLiteColumn | SQL, roles: readonly WorkspaceRole[]): SQL {
  if (roles.length === 0) return sql`0`;
  return sql`${expr} IN (${sql.join(
    roles.map((r) => sql`${r}`),
    sql`, `,
  )})`;
}

/** True when a member with `actorRole` may do `action` to one holding `targetRole`. */
export function mayActOn(
  actorRole: SQLiteColumn | SQL,
  targetRole: RoleExpr,
  action: WorkspaceAction,
): SQL {
  if (typeof targetRole === "string") return inList(actorRole, rolesActingOn(targetRole, action));
  return sql`(${sql.join(
    WORKSPACE_ROLES.map(
      (target) =>
        sql`(${targetRole} = ${target} AND ${inList(actorRole, rolesActingOn(target, action))})`,
    ),
    sql` OR `,
  )})`;
}

const actorRow = alias(memberships, "actor_membership");
const qb = new QueryBuilder();

/**
 * True while `actor` is a member of `workspaceId` whose current role may do
 * `action` to a target holding each of `targets`.
 */
export function actorMay(
  workspaceId: WorkspaceId | SQLiteColumn,
  actor: UserId | SQLiteColumn,
  action: WorkspaceAction,
  targets: readonly RoleExpr[],
): SQL {
  return exists(
    qb
      .select({ one: sql`1` })
      .from(actorRow)
      .where(
        and(
          eq(actorRow.workspaceId, workspaceId),
          eq(actorRow.userId, actor),
          ...targets.map((target) => mayActOn(actorRow.role, target, action)),
        ),
      ),
  );
}

/** True for an invite whose creator still holds a role allowed to issue its role. */
export function inviteBackedByCreator(): SQL {
  return actorMay(invites.workspaceId, invites.createdBy, "invite", [invites.role]);
}
