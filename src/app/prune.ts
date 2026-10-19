/**
 * Retention pruning for the append-only tables (events and webhook dead
 * letters, review P3/L5; the share audit; the activity logs; raw history),
 * expired sessions, long-expired invites, spent ceremony nonces, expired
 * access codes, expired OAuth state, and reverse geocoding answers past seven
 * days or their owner's retentionHours. The server runs it at boot and then
 * every few hours.
 */

import type { WhereCtxConfig } from "../config.js";
import type { SystemStores } from "./context.js";

export type PruneConfig = Pick<WhereCtxConfig, "events" | "sharing" | "activity" | "privacy">;

/** Rows removed from each table. */
export async function pruneOnce(system: SystemStores, config: PruneConfig): Promise<Record<string, number>> {
  const [events, deadLetters, shareAudit, accessLog, ingestLog, history, sessions, invites, nonces, accessCodes, oauth, geoCache] =
    await Promise.all([
      system.events.prune(config.events.retentionHours),
      system.webhooks.pruneDeadLetters(config.events.retentionHours),
      system.shares.pruneAudit(config.sharing.auditRetentionDays),
      system.accessLog.prune(config.activity.accessLogRetentionDays),
      system.ingestLog.prune(config.activity.ingestLogRetentionDays),
      system.history.pruneExpired(config.privacy.retentionHours),
      system.sessions.prune(),
      system.invites.pruneExpired(config.events.retentionHours),
      system.nonces.prune(),
      system.accessCodes.prune(),
      system.oauth.prune(),
      system.geo.prune(),
    ]);
  return { events, deadLetters, shareAudit, accessLog, ingestLog, history, sessions, invites, nonces, accessCodes, oauth, geoCache };
}
