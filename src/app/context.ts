/**
 * Application context — the dependency container wired once at startup.
 *
 * Two handles, split by who may cross user boundaries:
 * - `system` holds the raw stores and service. Only boot, the dispatcher, the
 *   periodic sweeps, and the auth boundary (src/auth/principal.ts) receive it.
 * - `forUser(userId)` returns a `UserScope` whose methods are already bound to
 *   one user. Route handlers and MCP tools see only a scope, so calling another
 *   user's data or a cross-user method is a type error rather than a review item.
 *
 * Account routes mirror this: `forSession(actor)` returns an `AccountScope`
 * pre-bound to one signed-in session (its own account, workspace actions
 * checked against the actor's role, and location sharing with co-members),
 * and `auth` is the narrow handle for the unauthenticated sign-in ceremonies.
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
import { AccessCodesStore } from "../accounts/accessCodesStore.js";
import { PasskeyAuth, generateSetupCode, setupCodeHash } from "../accounts/authService.js";
import { Ceremonies } from "../accounts/ceremonies.js";
import { InvitesStore } from "../accounts/invitesStore.js";
import { NoncesStore } from "../accounts/noncesStore.js";
import { SimpleWebAuthnCeremony, type PasskeyCeremony } from "../accounts/passkeys.js";
import { PasskeysStore } from "../accounts/passkeysStore.js";
import { RecoveryStore } from "../accounts/recoveryStore.js";
import { SelfService } from "../accounts/selfService.js";
import { ServerSecretsStore } from "../accounts/serverSecretsStore.js";
import { SessionsStore } from "../accounts/sessionsStore.js";
import type { Actor } from "../accounts/types.js";
import { UsersStore } from "../accounts/usersStore.js";
import { WorkspaceService } from "../accounts/workspaceService.js";
import { WorkspacesStore } from "../accounts/workspacesStore.js";
import { SharesStore } from "../sharing/sharesStore.js";
import { SharingService } from "../sharing/sharingService.js";
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
  users: UsersStore;
  workspaces: WorkspacesStore;
  invites: InvitesStore;
  passkeys: PasskeysStore;
  sessions: SessionsStore;
  recovery: RecoveryStore;
  accessCodes: AccessCodesStore;
  serverSecrets: ServerSecretsStore;
  nonces: NoncesStore;
  shares: SharesStore;
}

type Unbound<F, A> = F extends (first: A, ...args: infer P) => infer R ? (...args: P) => R : never;
type Bound<T, K extends keyof T, A> = { readonly [P in K]: Unbound<T[P], A> };

/** Pick `keys` of `target` with their leading argument (a user or an actor) fixed. */
function bindFirst<T, A, K extends keyof T>(target: T, first: A, keys: readonly K[]): Bound<T, K, A> {
  const bound = {} as Record<K, unknown>;
  for (const key of keys) {
    const fn = target[key] as (...args: unknown[]) => unknown;
    bound[key] = (...args: unknown[]) => fn.call(target, first, ...args);
  }
  return bound as Bound<T, K, A>;
}

function scopeFor(system: SystemStores, userId: UserId) {
  return {
    userId,
    tokens: bindFirst(system.tokens, userId, ["list", "count", "create", "revoke"]),
    settings: bindFirst(system.settings, userId, ["getOrSeed"]),
    places: bindFirst(system.places, userId, ["list", "count", "get", "upsert", "deleteByName"]),
    presence: {
      ...bindFirst(system.presence, userId, ["getCurrent"]),
      ...bindFirst(system.service, userId, [
        "processReading",
        "checkStale",
        "reevaluateCurrent",
        "changePrivacySettings",
      ]),
    },
    events: bindFirst(system.events, userId, ["listRecent"]),
    history: bindFirst(system.history, userId, ["listRecent"]),
    reminders: bindFirst(system.reminders, userId, ["create", "countActive", "listActive"]),
    webhooks: bindFirst(system.webhooks, userId, [
      "list",
      "count",
      "create",
      "delete",
      "listDeadLetters",
    ]),
  };
}

interface AccountServices {
  self: SelfService;
  workspaces: WorkspaceService;
  sharing: SharingService;
}

function accountScopeFor({ self, workspaces, sharing }: AccountServices, actor: Actor) {
  return {
    sessionId: actor.sessionId,
    me: bindFirst(self, actor, [
      "profile",
      "rename",
      "reauthOptions",
      "reauthVerify",
      "addPasskeyOptions",
      "addPasskeyVerify",
      "deletePasskey",
      "regenerateRecoveryCodes",
      "revokeSession",
      "revokeOtherSessions",
    ]),
    workspaces: bindFirst(workspaces, actor, [
      "list",
      "create",
      "rename",
      "listMembers",
      "changeRole",
      "removeMember",
      "createInvite",
      "listInvites",
      "revokeInvite",
      "acceptInvite",
    ]),
    sharing: bindFirst(sharing, actor, ["list", "put", "revoke", "decline", "people", "person", "audit"]),
  };
}

/**
 * What one signed-in person may do to their account and workspaces; every
 * method is pre-bound to their session, like UserScope is to a user.
 */
export type AccountScope = ReturnType<typeof accountScopeFor>;

/** Everything one user may do; every method is pre-bound to that user. */
export type UserScope = ReturnType<typeof scopeFor>;

export interface AppContext {
  config: WhereCtxConfig;
  handle: DbHandle;
  clock: Clock;
  system: SystemStores;
  forUser(userId: UserId): UserScope;
  forSession(actor: Actor): AccountScope;
  /** Sign-in ceremonies for people without a session yet. */
  auth: PasskeyAuth;
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
  /** One-time code for registering the first passkey; set while none exists. */
  setupCode?: string;
}

export interface AppContextOptions {
  clock?: Clock;
  /** Replaces the SimpleWebAuthn-backed ceremony (tests). */
  ceremony?: PasskeyCeremony;
}

/**
 * Build the context: open + migrate the DB, instantiate stores/services, seed
 * the privacy settings row and bootstrap tokens. Returns the context plus
 * bootstrap info (seeded roles, warnings, any generated admin secret) for the
 * caller to log.
 */
export async function createAppContext(
  config: WhereCtxConfig,
  options: AppContextOptions = {},
): Promise<{ ctx: AppContext; bootstrap: BootstrapInfo }> {
  const clock = options.clock ?? systemClock;
  const handle = createDb(config.databaseUrl);
  await ensureSchema(handle);
  const db = handle.db;

  const secretBox = config.webhooks.encryptionKey
    ? new SecretBox(config.webhooks.encryptionKey)
    : undefined;
  const users = new UsersStore(db, clock);
  const passkeys = new PasskeysStore(db, clock);
  const workspaces = new WorkspacesStore(
    db,
    { allowMemberWorkspaces: config.allowMemberWorkspaces, ownerId: config.defaultUserId },
    clock,
  );
  const stores = {
    tokens: new TokenStore(db, clock),
    settings: new SettingsStore(db, config, clock),
    presence: new PresenceStore(db),
    places: new PlacesStore(db, clock),
    events: new EventsStore(db, clock),
    history: new HistoryStore(db, clock),
    reminders: new RemindersStore(db, clock),
    webhooks: new WebhooksStore(db, clock, secretBox),
    users,
    workspaces,
    invites: new InvitesStore(db, { users, passkeys, workspaces }, clock),
    passkeys,
    sessions: new SessionsStore(db, clock),
    recovery: new RecoveryStore(db, clock),
    accessCodes: new AccessCodesStore(db, passkeys, clock),
    serverSecrets: new ServerSecretsStore(db, clock),
    nonces: new NoncesStore(db, clock),
    shares: new SharesStore(db, clock),
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

  // `defaultUserId` is read only here: it owns the env-configured tokens, the
  // first settings row, the Default workspace, and the setup passkey. Request
  // paths take their user from the credential.
  const owner = config.defaultUserId;
  await system.settings.getOrSeed(owner);
  await system.users.ensure(owner, owner);
  await system.workspaces.ensureDefault(owner);
  const seed = await system.tokens.seedBootstrap(owner, config.bootstrapTokens);
  const setupCode = await rotateSetupCode(system);

  const ceremonies = new Ceremonies(await system.serverSecrets.ceremonyKey(), system.nonces, clock);
  const webauthn = options.ceremony ?? new SimpleWebAuthnCeremony(config);
  const self = new SelfService({
    ...pick(system, ["users", "workspaces", "passkeys", "sessions", "recovery"]),
    ceremonies,
    webauthn,
    clock,
  });
  const services: AccountServices = {
    self,
    workspaces: new WorkspaceService(pick(system, ["workspaces", "invites"]), config),
    sharing: new SharingService(pick(system, ["shares", "settings"]), clock),
  };

  const ctx: AppContext = {
    config,
    handle,
    clock,
    system,
    forUser: (userId) => scopeFor(system, userId),
    forSession: (actor) => accountScopeFor(services, actor),
    auth: new PasskeyAuth({
      ...pick(system, [
        "users",
        "passkeys",
        "sessions",
        "recovery",
        "invites",
        "accessCodes",
        "serverSecrets",
        "settings",
      ]),
      ceremonies,
      webauthn,
      ownerId: owner,
    }),
  };

  return { ctx, bootstrap: { seed, setupCode } };
}

/**
 * While no passkey exists, mint a fresh setup code (only its hash is stored,
 * so any instance can check it); once one does, drop any leftover hash.
 */
async function rotateSetupCode(system: SystemStores): Promise<string | undefined> {
  if ((await system.passkeys.countAll()) > 0) {
    await system.serverSecrets.clearSetupCode();
    return undefined;
  }
  const code = generateSetupCode();
  await system.serverSecrets.putSetupCodeHash(setupCodeHash(code));
  return code;
}

function pick<T, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) out[key] = source[key];
  return out;
}

export function closeAppContext(ctx: AppContext): void {
  ctx.handle.client.close();
}
