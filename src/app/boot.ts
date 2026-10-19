/**
 * The server's startup sequence, from a loaded config to a listening
 * http.Server: build the context, print the boot banners, wire the webhook
 * dispatcher and the sweeps, and serve the composed listener (app/listener.ts:
 * /mcp, the OAuth protocol endpoints, and the Hono app). `close` undoes it in order.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { WhereCtxConfig } from "../config.js";
import { RateLimiter } from "../api/rateLimit.js";
import { passkeyBaseUrlProblem } from "../accounts/passkeys.js";
import { createAppContext, closeAppContext, type AppContext, type AppContextOptions } from "./context.js";
import type { BuildAppOptions } from "./server.js";
import { createListener } from "./listener.js";
import { pruneOnce } from "./prune.js";
import { WebhookDispatcher } from "../webhooks/dispatcher.js";
import { log } from "../util/log.js";

const STALE_SWEEP_MS = 60_000;
const WEBHOOK_TICK_MS = 15_000;
const PRUNE_SWEEP_MS = 6 * 3600_000;

export interface Running {
  ctx: AppContext;
  server: Server;
  /** The bound port (useful with port 0). */
  port: number;
  close(): Promise<void>;
}

const RULE = "──────────────────────────────────────────────────────────────";

export async function startServer(
  config: WhereCtxConfig,
  options: AppContextOptions & Pick<BuildAppOptions, "dashboardDir"> = {},
): Promise<Running> {
  const { ctx, bootstrap } = await createAppContext(config, options);

  for (const w of bootstrap.seed.warnings) log.warn(w);
  if (bootstrap.seed.seeded.length > 0) {
    log.info("seeded tokens", { roles: bootstrap.seed.seeded.join(",") });
  }
  if (bootstrap.seed.generatedAdminSecret) {
    log.banner`
${RULE}
  USER_ID "${config.defaultUserId}" had no admin token, so one was generated.
  Save it now — it will not be shown again:

    ${bootstrap.seed.generatedAdminSecret}
${RULE}
`;
  }

  const passkeyProblem = passkeyBaseUrlProblem(config.baseUrl);
  if (passkeyProblem) log.warn(passkeyProblem);

  if (bootstrap.setupCode) {
    log.banner`
${RULE}
  No passkey is registered yet. This one-time setup code lets
  you register the owner's passkey:

    ${bootstrap.setupCode}

  Open ${config.baseUrl}/dashboard and choose "First-time setup".
  The code works until the first passkey is registered; a restart
  replaces it.
${RULE}
`;
  }

  // Webhook secret hygiene: encrypt any legacy plaintext secrets once a key is
  // configured, and warn when secrets are stored without one (review H2).
  if (config.webhooks.encryptionKey) {
    const migrated = await ctx.system.webhooks.encryptLegacySecrets();
    if (migrated > 0) {
      log.info("encrypted legacy webhook signing secrets at rest", { count: migrated });
    }
  } else if (await ctx.system.webhooks.hasPlaintextSecrets()) {
    log.warn("webhook signing secrets are stored as plaintext; set WEBHOOK_ENCRYPTION_KEY to encrypt them at rest");
  }
  const stuck = await ctx.system.webhooks.undeliverableAuthHeaders();
  if (stuck > 0) {
    log.warn(
      config.webhooks.encryptionKey
        ? "webhooks have an auth header stored unencrypted and are not delivered; replace or remove each one's auth header in the dashboard"
        : "webhooks have an auth header but WEBHOOK_ENCRYPTION_KEY is not set, so they are not delivered; set the key they were saved with",
      { count: stuck },
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

  // Periodic sweeps: became_stale fires even with no reads, and a pending
  // enter or leave is confirmed once its dwell time passes with no new reading.
  const staleSweep = setInterval(() => {
    const nudgeOn = (events: unknown[]) => {
      if (events.length > 0) dispatcher.nudge();
    };
    ctx.system.service
      .sweepStale()
      .then(nudgeOn)
      .catch((e) => log.error("stale sweep failed", e));
    ctx.system.service
      .sweepDwell()
      .then(nudgeOn)
      .catch((e) => log.error("dwell sweep failed", e));
  }, STALE_SWEEP_MS);
  staleSweep.unref?.();

  const prune = (): void => {
    pruneOnce(ctx.system, config).catch((e) => log.error("prune sweep failed", e));
  };
  prune();
  const pruneSweep = setInterval(prune, PRUNE_SWEEP_MS);
  pruneSweep.unref?.();

  // One shared limiter so REST and MCP auth failures count together.
  const server = createServer(
    createListener(ctx, { authLimiter: new RateLimiter(), dashboardDir: options.dashboardDir }),
  );

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  const port = (server.address() as AddressInfo).port;
  log.info(`WhereCtx listening on http://${config.host}:${port}`, { baseUrl: config.baseUrl });

  const close = async (): Promise<void> => {
    const drained = dispatcher.stop();
    clearInterval(staleSweep);
    clearInterval(pruneSweep);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // In-flight drains write cursors; let them return before the DB closes.
    await drained;
    // Background area lookups write presence; the same holds for them.
    await ctx.system.geo.close();
    closeAppContext(ctx);
  };

  return { ctx, server, port, close };
}
