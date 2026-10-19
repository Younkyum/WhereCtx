/**
 * People's own maps provider keys (BYOK). The credential is sealed with
 * AES-256-GCM before it is written and opened only to make a provider call;
 * nothing here returns it to a caller outside the server. Listing answers the
 * provider, a four-character hint and how the key last fared.
 */

import { and, eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { geoCredentials } from "../db/schema.js";
import type { UserId } from "../types.js";
import { nowIso, systemClock, type Clock } from "../util/time.js";
import { isEncryptedSecret, type SecretBox } from "../webhooks/secretBox.js";
import type { GeoCredentials, GeoProviderName } from "./types.js";

export interface StoredGeoCredential {
  provider: GeoProviderName;
  /** The last four characters of the key (Kakao) or the Client ID (Naver). */
  hint: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  /** Why the last call with this key failed, cleared by the next success. */
  lastError: string | null;
}

function hintOf(credentials: GeoCredentials): string {
  const visible = credentials.provider === "kakao" ? credentials.restKey : credentials.clientId;
  return visible.slice(-4);
}

const toStored = (row: typeof geoCredentials.$inferSelect): StoredGeoCredential => ({
  provider: row.provider,
  hint: row.hint,
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

  async list(userId: UserId): Promise<StoredGeoCredential[]> {
    const rows = await this.db.select().from(geoCredentials).where(eq(geoCredentials.userId, userId));
    return rows.map(toStored).sort((a, b) => a.provider.localeCompare(b.provider));
  }

  /** The opened credential, for a provider call. */
  async open(userId: UserId, provider: GeoProviderName): Promise<GeoCredentials | null> {
    const rows = await this.db
      .select({ secret: geoCredentials.secret })
      .from(geoCredentials)
      .where(and(eq(geoCredentials.userId, userId), eq(geoCredentials.provider, provider)))
      .limit(1);
    const sealed = rows[0]?.secret;
    if (sealed === undefined) return null;
    // A row is only ever written sealed; refuse anything else rather than use it.
    if (!isEncryptedSecret(sealed)) throw new Error("a maps credential is not sealed");
    return { ...(JSON.parse(this.box.decrypt(sealed)) as object), provider } as GeoCredentials;
  }

  async put(userId: UserId, credentials: GeoCredentials): Promise<StoredGeoCredential> {
    const now = nowIso(this.clock);
    const { provider, ...secret } = credentials;
    const sealed = this.box.encrypt(JSON.stringify(secret));
    const hint = hintOf(credentials);
    const [row] = await this.db
      .insert(geoCredentials)
      .values({ userId, provider, secret: sealed, hint, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [geoCredentials.userId, geoCredentials.provider],
        set: { secret: sealed, hint, updatedAt: now, lastUsedAt: null, lastError: null },
      })
      .returning();
    return toStored(row!);
  }

  async delete(userId: UserId, provider: GeoProviderName): Promise<boolean> {
    const result = await this.db
      .delete(geoCredentials)
      .where(and(eq(geoCredentials.userId, userId), eq(geoCredentials.provider, provider)));
    return result.rowsAffected > 0;
  }

  /** Note how a call with the key went: `error` null for a success. */
  async markUsed(userId: UserId, provider: GeoProviderName, error: string | null): Promise<void> {
    await this.db
      .update(geoCredentials)
      .set({ lastUsedAt: nowIso(this.clock), lastError: error })
      .where(and(eq(geoCredentials.userId, userId), eq(geoCredentials.provider, provider)));
  }
}
