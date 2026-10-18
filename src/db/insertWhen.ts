/**
 * Conditional single-row inserts for multi-statement batches.
 *
 * A batch runs as one transaction but cannot branch, so a statement that must
 * land only if an earlier one did (an invite claim, an access-code check) is
 * written as `INSERT INTO t SELECT <row> FROM <source> WHERE <condition>`: it
 * inserts the row once per matching source row, which callers keep to at most
 * one by keying the condition on a unique column, or by reading `ONE_ROW`.
 * Each store builds these for its own table, so no store spells out another
 * table's columns. A value may be a column or SQL expression of the source
 * row, to copy what the row held before a later statement in the batch
 * changes it.
 */

import { Column, getTableColumns, is, SQL, sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Database } from "./index.js";

/** A source yielding exactly one row, for a condition that reads no table. */
export const ONE_ROW = sql`(SELECT 1)`;

export interface InsertCondition {
  /** What the condition reads; it yields the row once per match. */
  from: SQLiteTable | SQL;
  where: SQL;
}

type RowOf<T extends SQLiteTable> = {
  [K in keyof Required<T["$inferInsert"]>]: Required<T["$inferInsert"]>[K] | SQL | Column;
};

export function insertWhen<T extends SQLiteTable>(
  db: Database,
  table: T,
  row: RowOf<T>,
  when: InsertCondition,
) {
  const values = row as Record<string, unknown>;
  const selection: Record<string, SQL.Aliased> = {};
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    const value = values[key];
    const expr =
      value === null || value === undefined ? sql`NULL`
      : is(value, SQL) || is(value, Column) ? sql`${value}`
      : sql`${sql.param(value, column)}`;
    selection[key] = expr.as(column.name);
  }
  // Drizzle checks at runtime that the selection matches the table's columns
  // in order; getTableColumns yields exactly that order.
  return db.insert(table).select(db.select(selection).from(when.from).where(when.where) as never);
}
