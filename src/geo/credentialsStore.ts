/**
 * People's own maps provider keys (BYOK), one row per person and provider.
 * The row's keys, by kind (GEO_KEY_KINDS), are sealed together with
 * AES-256-GCM before they are written and opened only to make a provider
 * call; nothing here returns them to a caller outside the server. Listing
 * answers which kinds are held, a four-character hint of the non-secret
 * ones, and how the keys last fared.
 */

import { and, eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { geoCredentials } from "../db/schema.js";
import type { UserId } from "../types.js";
import { nowIso, systemClock, type Clock } from "../util/time.js";
import { isEncryptedSecret, type SecretBox } from "../webhooks/secretBox.js";
import { HINTED_KINDS, type GeoKeyBag, type GeoProviderName } from "./types.js";

export interface StoredGeoCredential {
  provider: GeoProviderName;
  /** The kinds held, each with its last four characters when it is not itself a secret, else "". */
  kinds: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  /** Why the last call with these keys failed, cleared by the next success. */
  lastError: string | null;
}

function hintsOf(keys: GeoKeyBag): Record<string, string> {
  const hints: Record<string, string> = {};
  for (const [kind, value] of Object.entries(keys)) {
    if (value) hints[kind] = HINTED_KINDS.has(kind) ? value.slice(-4) : "";
  }
  return hints;
}

const toStored = (row: typeof geoCredentials.$inferSelect): StoredGeoCredential => ({
  provider: row.provider,
  kinds: row.hints,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  lastUsedAt: row.lastUsedAt,
  lastError: row.lastError,
});

export class GeoCredentialsStore {
  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
    private readonly clock: Clock = systemClock,
  ) {}

  private where(userId: UserId, provider: GeoProviderName) {
    return and(eq(geoCredentials.userId, userId), eq(geoCredentials.provider, provider));
  }

  async list(userId: UserId): Promise<StoredGeoCredential[]> {
    const rows = await this.db.select().from(geoCredentials).where(eq(geoCredentials.userId, userId));
    return rows.map(toStored).sort((a, b) => a.provider.localeCompare(b.provider));
  }

  /** The opened keys, for a provider call. */
  async open(userId: UserId, provider: GeoProviderName): Promise<GeoKeyBag | null> {
    const rows = await this.db
      .select({ secret: geoCredentials.secret })
      .from(geoCredentials)
      .where(this.where(userId, provider))
      .limit(1);
    const sealed = rows[0]?.secret;
    if (sealed === undefined) return null;
    // A row is only ever written sealed; refuse anything else rather than use it.
    if (!isEncryptedSecret(sealed)) throw new Error("a maps credential is not sealed");
    return JSON.parse(this.box.decrypt(sealed)) as GeoKeyBag;
  }

  /**
   * Save keys for a provider. Kinds not named keep their stored value, so
   * saving one kind never drops another; `null` removes a kind.
   */
  async put(userId: UserId, provider: GeoProviderName, change: Record<string, string | null>): Promise<StoredGeoCredential> {
    const now = nowIso(this.clock);
    const merged: GeoKeyBag = { ...((await this.open(userId, provider)) ?? {}) };
    for (const [kind, value] of Object.entries(change)) {
      if (value === null) delete merged[kind];
      else merged[kind] = value;
    }
    const sealed = this.box.encrypt(JSON.stringify(merged));
    const hints = hintsOf(merged);
    const [row] = await this.db
      .insert(geoCredentials)
      .values({ userId, provider, secret: sealed, hints, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [geoCredentials.userId, geoCredentials.provider],
        set: { secret: sealed, hints, updatedAt: now, lastUsedAt: null, lastError: null },
      })
      .returning();
    return toStored(row!);
  }

  async delete(userId: UserId, provider: GeoProviderName): Promise<boolean> {
    const result = await this.db.delete(geoCredentials).where(this.where(userId, provider));
    return result.rowsAffected > 0;
  }

  /** Note how a call with the keys went: `error` null for a success. */
  async markUsed(userId: UserId, provider: GeoProviderName, error: string | null): Promise<void> {
    await this.db
      .update(geoCredentials)
      .set({ lastUsedAt: nowIso(this.clock), lastError: error })
      .where(this.where(userId, provider));
  }
}
