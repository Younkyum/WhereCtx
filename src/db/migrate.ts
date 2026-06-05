/**
 * Standalone migration runner (`npm run db:migrate`).
 * Useful for CI or running migrations without booting the full server.
 */

import { loadConfig } from "../config.js";
import { createDb, ensureSchema } from "./index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const handle = createDb(config.databaseUrl);
  await ensureSchema(handle);
  handle.client.close();
  // eslint-disable-next-line no-console
  console.log(`✓ schema applied to ${config.databaseUrl}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("migration failed:", err);
  process.exit(1);
});
