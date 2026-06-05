/**
 * WhereCtx server entrypoint.
 * Loads config, builds the app context (DB + stores + services), starts the
 * HTTP server, and prints bootstrap info (seeded tokens, any generated admin
 * secret, warnings).
 */

import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createAppContext, closeAppContext } from "./app/context.js";
import { buildApp } from "./app/server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const { ctx, bootstrap } = await createAppContext(config);

  // Surface bootstrap token info prominently.
  for (const w of bootstrap.seed.warnings) {
    console.warn(`⚠️  ${w}`);
  }
  if (bootstrap.seed.seeded.length > 0) {
    console.log(`✓ seeded tokens: ${bootstrap.seed.seeded.join(", ")}`);
  }
  if (bootstrap.seed.generatedAdminSecret) {
    console.log(
      "\n──────────────────────────────────────────────────────────────\n" +
        "  No usable tokens were configured, so an ADMIN token was generated.\n" +
        "  Save it now — it will not be shown again:\n\n" +
        `    ${bootstrap.seed.generatedAdminSecret}\n` +
        "──────────────────────────────────────────────────────────────\n",
    );
  }

  const app = buildApp(ctx);
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`WhereCtx listening on http://${config.host}:${info.port}  (base: ${config.baseUrl})`);
  });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      // Second signal: force quit.
      process.exit(1);
    }
    shuttingDown = true;
    console.log("shutting down…");
    // Stop accepting connections, drain in-flight requests, THEN close the DB.
    server.close(() => {
      closeAppContext(ctx);
      process.exit(0);
    });
    // Safety net: force-exit if draining hangs.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
