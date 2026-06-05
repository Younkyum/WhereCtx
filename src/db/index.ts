/**
 * Database connection + schema bootstrap.
 *
 * Uses libsql (SQLite-compatible) which ships prebuilt binaries across Node
 * versions, avoiding native-compile friction during self-hosting installs.
 *
 * On startup we ensure the data directory exists, open the connection, and run
 * `ensureSchema()` which applies the generated Drizzle migrations. Migrations
 * are the single source of truth; the `drizzle/` folder is committed to the repo
 * and shipped in the Docker image, so it is present in every real deployment. If
 * it is genuinely missing we fail loudly rather than silently forking a second,
 * drift-prone schema definition (which would also break the upgrade path by
 * bypassing drizzle's migration ledger).
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { schema } from "./schema.js";

export type Database = LibSQLDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  client: Client;
}

/** Ensure the parent directory for a `file:` libsql URL exists. */
function ensureDataDir(databaseUrl: string): void {
  if (!databaseUrl.startsWith("file:")) return;
  const path = databaseUrl.slice("file:".length);
  if (path === "" || path === ":memory:") return;
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
  const dir = dirname(abs);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function createDb(databaseUrl: string): DbHandle {
  ensureDataDir(databaseUrl);
  const client = createClient({ url: databaseUrl });
  const db = drizzle(client, { schema });
  return { db, client };
}

/** Resolve the migrations folder relative to this module (works from src or dist). */
export function migrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/db/index.ts -> ../../drizzle ; dist/db/index.js -> ../../drizzle
  return resolve(here, "..", "..", "drizzle");
}

/**
 * Apply the generated migrations. Throws a clear error if the migrations folder
 * is missing so the operator knows to run `npm run db:generate` / rebuild the
 * image, instead of booting against an unknown schema.
 */
export async function ensureSchema(handle: DbHandle): Promise<void> {
  const folder = migrationsFolder();
  if (!existsSync(folder)) {
    throw new Error(
      `Migrations folder not found at ${folder}. ` +
        `Run "npm run db:generate" to create it, or ensure the drizzle/ ` +
        `directory is shipped alongside the build.`,
    );
  }
  await migrate(handle.db, { migrationsFolder: folder });
}
