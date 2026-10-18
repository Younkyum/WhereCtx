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
import { RateLimiter } from "./api/rateLimit.js";
import { passkeyBaseUrlProblem } from "./accounts/passkeys.js";
import { createAppContext, closeAppContext } from "./app/context.js";
import { buildApp } from "./app/server.js";
import { mcpNodeHandler } from "./mcp/http.js";
import { WebhookDispatcher } from "./webhooks/dispatcher.js";
import { log } from "./util/log.js";

const STALE_SWEEP_MS = 60_000;
const WEBHOOK_TICK_MS = 15_000;
const PRUNE_SWEEP_MS = 6 * 3600_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const { ctx, bootstrap } = await createAppContext(config);

  for (const w of bootstrap.seed.warnings) log.warn(w);
  if (bootstrap.seed.seeded.length > 0) {
    log.info("seeded tokens", { roles: bootstrap.seed.seeded.join(",") });
  }
  // The banners carry a secret the operator must read, so they bypass the
  // redacting log and its in-memory ring (which the dashboard shows).
  if (bootstrap.seed.generatedAdminSecret) {
    log.banner(
      "\n──────────────────────────────────────────────────────────────\n" +
        `  USER_ID "${config.defaultUserId}" had no admin token, so one was generated.\n` +
        "  Save it now — it will not be shown again:\n\n" +
        `    ${bootstrap.seed.generatedAdminSecret}\n` +
        "──────────────────────────────────────────────────────────────\n",
    );
  }

  const passkeyProblem = passkeyBaseUrlProblem(config.baseUrl);
  if (passkeyProblem) log.warn(passkeyProblem);

  if (bootstrap.setupCode) {
    log.banner(
      "\n──────────────────────────────────────────────────────────────\n" +
        "  No passkey is registered yet. This one-time setup code lets\n" +
        "  you register the owner's passkey:\n\n" +
        `    ${bootstrap.setupCode}\n\n` +
        `  Open ${config.baseUrl}/dashboard and choose "First-time setup".\n` +
        "  The code works until the first passkey is registered; a restart\n" +
        "  replaces it.\n" +
        "──────────────────────────────────────────────────────────────\n",
    );
  }

  // Webhook secret hygiene: encrypt any legacy plaintext secrets once a key is
  // configured, and warn when secrets are stored without one (review H2).
  if (config.webhooks.encryptionKey) {
    const migrated = await ctx.system.webhooks.encryptLegacySecrets();
    if (migrated > 0) {
      log.info("encrypted legacy webhook secrets at rest", { count: migrated });
    }
  } else if (await ctx.system.webhooks.hasPlaintextSecrets()) {
    log.warn(
      "webhook signing secrets are stored as plaintext; set WEBHOOK_ENCRYPTION_KEY to encrypt them at rest",
    );
  }

  // Webhook delivery: nudge on every emitted event, plus a periodic tick.
  const dispatcher = new WebhookDispatcher({
    webhooksStore: ctx.system.webhooks,
    eventsStore: ctx.system.events,
    clock: ctx.clock,
    allowPrivateTargets: config.webhooks.allowPrivateTargets,
  });
  ctx.onEvents = () => dispatcher.nudge();
  dispatcher.start(WEBHOOK_TICK_MS);

  // Periodic stale sweep: fires became_stale even with no reads.
  const staleSweep = setInterval(() => {
    ctx.system.service
      .sweepStale()
      .then((events) => {
        if (events.length > 0) dispatcher.nudge();
      })
      .catch((e) => log.error("stale sweep failed", e));
  }, STALE_SWEEP_MS);
  staleSweep.unref?.();

  // Retention pruning for the append-only tables (events + webhook dead-letters,
  // review P3/L5, the share audit, the activity logs), expired sessions,
  // long-expired invites, spent ceremony nonces, and expired access codes.
  // Runs at boot and then every few hours.
  const pruneOnce = (): void => {
    void Promise.all([
      ctx.system.events.prune(config.events.retentionHours),
      ctx.system.webhooks.pruneDeadLetters(config.events.retentionHours),
      ctx.system.shares.pruneAudit(config.sharing.auditRetentionDays),
      ctx.system.accessLog.prune(config.activity.accessLogRetentionDays),
      ctx.system.ingestLog.prune(config.activity.ingestLogRetentionDays),
      ctx.system.sessions.prune(),
      ctx.system.invites.pruneExpired(config.events.retentionHours),
      ctx.system.nonces.prune(),
      ctx.system.accessCodes.prune(),
    ]).catch((e) => log.error("prune sweep failed", e));
  };
  pruneOnce();
  const pruneSweep = setInterval(pruneOnce, PRUNE_SWEEP_MS);
  pruneSweep.unref?.();

  // One shared limiter so REST and MCP auth failures count together.
  const authLimiter = new RateLimiter();
  const app = buildApp(ctx, { authLimiter });
  const honoListener = getRequestListener(app.fetch);
  const mcp = mcpNodeHandler(ctx, authLimiter);

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
    log.info(`WhereCtx listening on http://${config.host}:${config.port}`, { baseUrl: config.baseUrl });
  });

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    log.info("shutting down");
    const drained = dispatcher.stop();
    clearInterval(staleSweep);
    clearInterval(pruneSweep);
    server.close(() => {
      // In-flight drains write cursors; let them return before the DB closes.
      void drained.finally(() => {
        closeAppContext(ctx);
        process.exit(0);
      });
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error("fatal", err);
  process.exit(1);
});
