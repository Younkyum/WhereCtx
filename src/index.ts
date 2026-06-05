/**
 * WhereCtx server entrypoint.
 *
 * Composes a single Node http.Server that routes `/mcp` to the MCP transport
 * (raw Node) and everything else to the Hono REST app (via getRequestListener).
 * Wires the webhook dispatcher to the event sink and starts a periodic stale
 * sweep so `presence.became_stale` fires without a client read.
 */

import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { createAppContext, closeAppContext } from "./app/context.js";
import { buildApp } from "./app/server.js";
import { mcpNodeHandler } from "./mcp/http.js";
import { WebhookDispatcher } from "./webhooks/dispatcher.js";

const STALE_SWEEP_MS = 60_000;
const WEBHOOK_TICK_MS = 15_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const { ctx, bootstrap } = await createAppContext(config);

  for (const w of bootstrap.seed.warnings) console.warn(`⚠️  ${w}`);
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

  // Webhook delivery: nudge on every emitted event, plus a periodic tick.
  const dispatcher = new WebhookDispatcher({
    webhooksStore: ctx.webhooksStore,
    eventsStore: ctx.eventsStore,
    clock: ctx.clock,
    allowPrivateTargets: config.webhooks.allowPrivateTargets,
  });
  ctx.onEvents = () => dispatcher.nudge();
  dispatcher.start(WEBHOOK_TICK_MS);

  // Periodic stale sweep (fires became_stale even with no reads).
  const staleSweep = setInterval(() => {
    void ctx.service
      .checkStale()
      .then((ev) => {
        if (ev) dispatcher.nudge();
      })
      .catch((e) => console.error("stale sweep error:", e));
  }, STALE_SWEEP_MS);
  staleSweep.unref?.();

  const app = buildApp(ctx);
  const honoListener = getRequestListener(app.fetch);
  const mcp = mcpNodeHandler(ctx);

  const server = createServer((req, res) => {
    // Match on the parsed pathname so query strings / encodings don't confuse
    // the /mcp vs Hono split. The MCP handler authenticates independently, so a
    // miss falling through to Hono is fail-safe (404, no auth bypass).
    let pathname = req.url ?? "";
    try {
      pathname = new URL(req.url ?? "", "http://localhost").pathname;
    } catch {
      /* keep raw */
    }
    if (pathname === "/mcp") {
      void mcp(req, res);
      return;
    }
    honoListener(req, res);
  });

  server.listen(config.port, config.host, () => {
    console.log(
      `WhereCtx listening on http://${config.host}:${config.port}  (base: ${config.baseUrl})`,
    );
    console.log(`  REST: /v1/*   MCP: /mcp   health: /healthz`);
  });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    console.log("shutting down…");
    dispatcher.stop();
    clearInterval(staleSweep);
    server.close(() => {
      closeAppContext(ctx);
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
