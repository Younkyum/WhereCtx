/**
 * WhereCtx server entrypoint: load the config, start the server (app/boot.ts),
 * and shut it down cleanly on SIGINT or SIGTERM.
 */

import { loadConfig } from "./config.js";
import { startServer } from "./app/boot.js";
import { log } from "./util/log.js";

async function main(): Promise<void> {
  const running = await startServer(loadConfig());

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    log.info("shutting down");
    void running.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error("fatal", err);
  process.exit(1);
});
