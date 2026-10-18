/**
 * Standalone migration runner (`npm run db:migrate`).
 * Useful for CI or running migrations without booting the full server.
 */

import { loadConfig } from "../config.js";
import { createDb, ensureSchema } from "./index.js";
import { log } from "../util/log.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const handle = createDb(config.databaseUrl);
  await ensureSchema(handle);
  handle.client.close();
  log.info("schema applied", { database: config.databaseUrl });
}

main().catch((err) => {
  log.error("migration failed", err);
  process.exit(1);
});
