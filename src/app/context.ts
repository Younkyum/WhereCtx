/**
 * Application context — the dependency container wired once at startup.
 *
 * Two handles, split by who may cross user boundaries:
 * - `system` holds the raw stores and service. Only boot, the dispatcher, the
 *   periodic sweeps, and the auth boundary (`resolvePrincipal`) receive it.
 * - `forUser(userId)` returns a `UserScope` whose methods are already bound to
 *   one user. Route handlers and MCP tools see only a scope, so calling another
 *   user's data or a cross-user method is a type error rather than a review item.
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
import { SecretBox } from "../webhooks/secretBox.js";
import { systemClock, type Clock } from "../util/time.js";
import type { PresenceEvent, UserId } from "../types.js";

export interface SystemStores {
  tokens: TokenStore;
  settings: SettingsStore;
  presence: PresenceStore;
  places: PlacesStore;
  events: EventsStore;
  history: HistoryStore;
  reminders: RemindersStore;
  webhooks: WebhooksStore;
  service: PresenceService;
}

type Unbound<F> = F extends (userId: UserId, ...args: infer A) => infer R
  ? (...args: A) => R
  : never;
type Bound<T, K extends keyof T> = { readonly [P in K]: Unbound<T[P]> };

/** Pick `keys` of `target` with their leading userId argument fixed. */
function bindUser<T, K extends keyof T>(
  target: T,
  userId: UserId,
  keys: readonly K[],
): Bound<T, K> {
  const bound = {} as Record<K, unknown>;
  for (const key of keys) {
    const fn = target[key] as (...args: unknown[]) => unknown;
    bound[key] = (...args: unknown[]) => fn.call(target, userId, ...args);
  }
  return bound as Bound<T, K>;
}

function scopeFor(system: SystemStores, userId: UserId) {
  return {
    userId,
    tokens: bindUser(system.tokens, userId, ["list", "count", "create", "revoke"]),
    settings: bindUser(system.settings, userId, ["getOrSeed"]),
    places: bindUser(system.places, userId, ["list", "count", "get", "upsert", "deleteByName"]),
    presence: {
      ...bindUser(system.presence, userId, ["getCurrent"]),
      ...bindUser(system.service, userId, [
        "processReading",
        "checkStale",
        "reevaluateCurrent",
        "changePrivacySettings",
      ]),
    },
    events: bindUser(system.events, userId, ["listRecent"]),
    history: bindUser(system.history, userId, ["listRecent"]),
    reminders: bindUser(system.reminders, userId, ["create", "countActive", "listActive"]),
    webhooks: bindUser(system.webhooks, userId, [
      "list",
      "count",
      "create",
      "delete",
      "listDeadLetters",
    ]),
  };
}

/** Everything one user may do; every method is pre-bound to that user. */
export type UserScope = ReturnType<typeof scopeFor>;

export interface AppContext {
  config: WhereCtxConfig;
  handle: DbHandle;
  clock: Clock;
  system: SystemStores;
  forUser(userId: UserId): UserScope;
  /**
   * Optional sink for freshly-emitted presence events. Wired by the webhook
   * dispatcher (Phase 4); ingest/privacy routes call it after producing events.
   * Failures here must never break the request path.
   */
  onEvents?: (events: PresenceEvent[]) => Promise<void> | void;
}

/** What route handlers and MCP tools may touch besides their user scope. */
export type RouteContext = Pick<AppContext, "config" | "clock" | "onEvents">;

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

  const secretBox = config.webhooks.encryptionKey
    ? new SecretBox(config.webhooks.encryptionKey)
    : undefined;
  const stores = {
    tokens: new TokenStore(db, clock),
    settings: new SettingsStore(db, config, clock),
    presence: new PresenceStore(db),
    places: new PlacesStore(db, clock),
    events: new EventsStore(db, clock),
    history: new HistoryStore(db, clock),
    reminders: new RemindersStore(db, clock),
    webhooks: new WebhooksStore(db, clock, secretBox),
  };
  const system: SystemStores = {
    ...stores,
    service: new PresenceService({
      config,
      presenceStore: stores.presence,
      placesStore: stores.places,
      eventsStore: stores.events,
      historyStore: stores.history,
      remindersStore: stores.reminders,
      settingsStore: stores.settings,
      clock,
    }),
  };

  // `defaultUserId` is read only here: it owns the env-configured tokens and
  // the first settings row. Request paths take their user from the credential.
  await system.settings.getOrSeed(config.defaultUserId);
  const seed = await system.tokens.seedBootstrap(config.defaultUserId, config.bootstrapTokens);

  const ctx: AppContext = {
    config,
    handle,
    clock,
    system,
    forUser: (userId) => scopeFor(system, userId),
  };

  return { ctx, bootstrap: { seed } };
}

export function closeAppContext(ctx: AppContext): void {
  ctx.handle.client.close();
}
