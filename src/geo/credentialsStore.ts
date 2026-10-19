/**
 * People's own maps provider keys (BYOK), one row per person and provider.
 * The row's keys, by kind (GEO_KEY_KINDS), are sealed together with
 * AES-256-GCM before they are written, bound to `<userId>|<provider>` so a
 * row copied to another person or provider does not open, and opened only to
 * make a provider call; nothing here returns them to a caller outside the
 * server. Listing answers which kinds are held, a four-character hint of the
 * non-secret ones, how the keys last fared, and whether the row can be used
 * at all.
 */

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/index.js";
import { geoCredentials } from "../db/schema.js";
import type { UserId } from "../types.js";
import { nowIso, systemClock, type Clock } from "../util/time.js";
import { isEncryptedSecret, type SecretBox } from "../webhooks/secretBox.js";
import { GEO_KEY_KINDS, HINTED_KINDS, restCredentials, type GeoCredentials, type GeoKeyBag, type GeoProviderName } from "./types.js";

/**
 * ok: the keys open and hold what the REST calls need. unusable: the row
 * cannot be opened (another install's key, a corrupted or tampered row);
 * calls skip it, and saving or removing it still works.
 *
 * Rows saved before maps were drawn on open tiles may also hold a map key
 * (jsKey, mapKeyId). It is ignored, a row holding only that is not listed,
 * and the next save or removal drops it.
 */
export type GeoCredentialStatus = "ok" | "unusable";

export interface StoredGeoCredential {
  provider: GeoProviderName;
  status: GeoCredentialStatus;
  /** The kinds held, each with its last four characters when it is not itself a secret, else "". */
  kinds: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  /** Why the last call with these keys failed (cleared by the next success), or why the row is unusable. */
  lastError: string | null;
}

export const UNUSABLE_KEY = "the saved key could not be opened; save it again";

const KeyBag = z.record(z.string(), z.string());

function hintsOf(keys: GeoKeyBag): Record<string, string> {
  const hints: Record<string, string> = {};
  for (const [kind, value] of Object.entries(keys)) {
    if (value) hints[kind] = HINTED_KINDS.has(kind) ? value.slice(-4) : "";
  }
  return hints;
}

type Row = typeof geoCredentials.$inferSelect;

/** Only the kinds a provider takes now (GEO_KEY_KINDS). */
function known(provider: GeoProviderName, bag: Record<string, string>): Record<string, string> {
  const kinds: readonly string[] = GEO_KEY_KINDS[provider];
  return Object.fromEntries(Object.entries(bag).filter(([kind]) => kinds.includes(kind)));
}

export class GeoCredentialsStore {
  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
    private readonly clock: Clock = systemClock,
  ) {}

  private where(userId: UserId, provider: GeoProviderName) {
    return and(eq(geoCredentials.userId, userId), eq(geoCredentials.provider, provider));
  }

  private static aad(userId: UserId, provider: GeoProviderName): string {
    return `${userId}|${provider}`;
  }

  /** The row's keys of the kinds a provider takes, or "unopenable" when it cannot be opened. */
  private unseal(row: Pick<Row, "userId" | "provider" | "secret">): GeoKeyBag | "unopenable" {
    if (!isEncryptedSecret(row.secret)) return "unopenable";
    try {
      const bag = KeyBag.safeParse(JSON.parse(this.box.decrypt(row.secret, GeoCredentialsStore.aad(row.userId as UserId, row.provider))));
      return bag.success ? known(row.provider, bag.data) : "unopenable";
    } catch {
      return "unopenable";
    }
  }

  /** The row as listed; null for a row that opens but holds no REST keys (a map key alone). */
  private toStored(row: Row): StoredGeoCredential | null {
    const keys = this.unseal(row);
    const usable = keys !== "unopenable";
    if (usable && !restCredentials(row.provider, keys)) return null;
    return {
      provider: row.provider,
      status: usable ? "ok" : "unusable",
      kinds: known(row.provider, row.hints),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastUsedAt: row.lastUsedAt,
      lastError: usable ? row.lastError : UNUSABLE_KEY,
    };
  }

  async list(userId: UserId): Promise<StoredGeoCredential[]> {
    const rows = await this.db.select().from(geoCredentials).where(eq(geoCredentials.userId, userId));
    return rows
      .map((r) => this.toStored(r))
      .filter((c) => c !== null)
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }

  /** The opened keys, for a provider call; null when none are saved, they hold no REST credential, or the row is unusable. */
  async open(userId: UserId, provider: GeoProviderName): Promise<GeoKeyBag | null> {
    const rows = await this.db
      .select({ userId: geoCredentials.userId, provider: geoCredentials.provider, secret: geoCredentials.secret })
      .from(geoCredentials)
      .where(this.where(userId, provider))
      .limit(1);
    const keys = rows[0] ? this.unseal(rows[0]) : "unopenable";
    return keys !== "unopenable" && restCredentials(provider, keys) ? keys : null;
  }

  /** Save a provider's REST keys, replacing whatever was saved for it before and forgetting how those fared. */
  async put(userId: UserId, credentials: GeoCredentials): Promise<StoredGeoCredential> {
    const { provider, ...keys } = credentials;
    const now = nowIso(this.clock);
    const sealed = this.box.encrypt(JSON.stringify(keys), GeoCredentialsStore.aad(userId, provider));
    const hints = hintsOf(keys);
    const [row] = await this.db
      .insert(geoCredentials)
      .values({ userId, provider, secret: sealed, hints, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [geoCredentials.userId, geoCredentials.provider],
        set: { secret: sealed, hints, updatedAt: now, lastUsedAt: null, lastError: null },
      })
      .returning();
    return this.toStored(row!)!;
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
