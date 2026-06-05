/**
 * Application context — the dependency container wired once at startup.
 * Holds the DB handle, repositories, services, and config. Routers and the MCP
 * server receive this object rather than reaching for globals (testable).
 */

import type { WhereCtxConfig } from "../config.js";
import { createDb, ensureSchema, type DbHandle } from "../db/index.js";
import { TokenStore, type SeedResult } from "../auth/tokens.js";
import { SettingsStore } from "../privacy/settingsStore.js";
import {
  EventsStore,
  HistoryStore,
  PlacesStore,
  PresenceStore,
  RemindersStore,
  WebhooksStore,
} from "../store/index.js";
import { PresenceService } from "../presence/service.js";
import { systemClock, type Clock } from "../util/time.js";
import type { PresenceEvent } from "../types.js";

export interface AppContext {
  config: WhereCtxConfig;
  handle: DbHandle;
  clock: Clock;
  tokens: TokenStore;
  settings: SettingsStore;
  presenceStore: PresenceStore;
  placesStore: PlacesStore;
  eventsStore: EventsStore;
  historyStore: HistoryStore;
  remindersStore: RemindersStore;
  webhooksStore: WebhooksStore;
  service: PresenceService;
  /**
   * Optional sink for freshly-emitted presence events. Wired by the webhook
   * dispatcher (Phase 4); ingest/privacy routes call it after producing events.
   * Failures here must never break the request path.
   */
  onEvents?: (events: PresenceEvent[]) => Promise<void> | void;
}

export interface BootstrapInfo {
  seed: SeedResult;
}

/**
 * Build the context: open + migrate the DB, instantiate stores/services, seed
 * the privacy settings row and bootstrap tokens. Returns the context plus
 * bootstrap info (seeded roles, warnings, any generated admin secret) for the
 * caller to log.
 */
export async function createAppContext(
  config: WhereCtxConfig,
  clock: Clock = systemClock,
): Promise<{ ctx: AppContext; bootstrap: BootstrapInfo }> {
  const handle = createDb(config.databaseUrl);
  await ensureSchema(handle);
  const db = handle.db;

  const tokens = new TokenStore(db, clock);
  const settings = new SettingsStore(db, clock);
  const presenceStore = new PresenceStore(db);
  const placesStore = new PlacesStore(db, clock);
  const eventsStore = new EventsStore(db, clock);
  const historyStore = new HistoryStore(db, clock);
  const remindersStore = new RemindersStore(db, clock);
  const webhooksStore = new WebhooksStore(db, clock);

  const service = new PresenceService({
    config,
    presenceStore,
    placesStore,
    eventsStore,
    historyStore,
    remindersStore,
    settingsStore: settings,
    clock,
  });

  // First-boot seeding (idempotent).
  await settings.seedFromConfig(config.userId, config);
  const seed = await tokens.seedBootstrap(config.bootstrapTokens);

  const ctx: AppContext = {
    config,
    handle,
    clock,
    tokens,
    settings,
    presenceStore,
    placesStore,
    eventsStore,
    historyStore,
    remindersStore,
    webhooksStore,
    service,
  };

  return { ctx, bootstrap: { seed } };
}

export function closeAppContext(ctx: AppContext): void {
  ctx.handle.client.close();
}
