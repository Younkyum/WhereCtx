/**
 * Per-install secrets kept in the database, so every instance sharing it
 * agrees: the key that signs WebAuthn ceremony state, the OAuth server's token
 * signing key and cookie key, the key that seals people's maps provider keys,
 * the key the reverse geocoding cache is keyed under, and the hash of the
 * first-owner setup code.
 */

import { generateKeyPairSync, randomBytes } from "node:crypto";
import type { JWK } from "oidc-provider";
import { eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { serverSecrets } from "../db/schema.js";
import { nowIso, type Clock, systemClock } from "../util/time.js";

const CEREMONY_KEY = "ceremony_key";
const OAUTH_SIGNING_KEY = "oauth_signing_jwk";
const OAUTH_COOKIE_KEY = "oauth_cookie_key";
const SETUP_CODE_HASH = "setup_code_hash";
const GEO_CREDENTIAL_KEY = "geo_credential_key";
const GEO_CACHE_KEY = "geo_cache_key";

export interface OAuthKeys {
  /** Private JWK the authorization server signs with (published at /oauth/jwks). */
  signingKey: JWK;
  /** Signs the authorization server's cookies. */
  cookieKey: string;
}

export class ServerSecretsStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  /** The ceremony signing key, created on first boot. */
  async ceremonyKey(): Promise<Buffer> {
    const value = await this.getOrCreate(CEREMONY_KEY, () => randomBytes(32).toString("base64url"));
    return Buffer.from(value, "base64url");
  }

  /** The OAuth server's keys, created on first boot. */
  async oauthKeys(): Promise<OAuthKeys> {
    const jwk = await this.getOrCreate(OAUTH_SIGNING_KEY, () =>
      JSON.stringify(
        generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" }),
      ),
    );
    const cookieKey = await this.getOrCreate(OAUTH_COOKIE_KEY, () => randomBytes(32).toString("base64url"));
    return { signingKey: JSON.parse(jwk) as JWK, cookieKey };
  }

  /** Seals people's maps provider keys (geo_credentials), created on first boot. */
  geoCredentialKey(): Promise<string> {
    return this.getOrCreate(GEO_CREDENTIAL_KEY, () => randomBytes(32).toString("base64url"));
  }

  /** Keys the reverse geocoding cache's cells (geo_cache), created on first boot. */
  geoCacheKey(): Promise<string> {
    return this.getOrCreate(GEO_CACHE_KEY, () => randomBytes(32).toString("base64url"));
  }

  setupCodeHash(): Promise<string | null> {
    return this.get(SETUP_CODE_HASH);
  }

  /** Replace the setup code hash (boot, while no passkey exists). */
  async putSetupCodeHash(hash: string): Promise<void> {
    const createdAt = nowIso(this.clock);
    await this.db
      .insert(serverSecrets)
      .values({ name: SETUP_CODE_HASH, value: hash, createdAt })
      .onConflictDoUpdate({ target: serverSecrets.name, set: { value: hash, createdAt } });
  }

  async clearSetupCode(): Promise<void> {
    await this.db.delete(serverSecrets).where(eq(serverSecrets.name, SETUP_CODE_HASH));
  }

  /** Insert-if-absent then read, so instances booting together converge on one value. */
  private async getOrCreate(name: string, make: () => string): Promise<string> {
    const stored = await this.get(name);
    if (stored !== null) return stored;
    await this.db
      .insert(serverSecrets)
      .values({ name, value: make(), createdAt: nowIso(this.clock) })
      .onConflictDoNothing();
    return (await this.get(name))!;
  }

  private async get(name: string): Promise<string | null> {
    const rows = await this.db
      .select({ value: serverSecrets.value })
      .from(serverSecrets)
      .where(eq(serverSecrets.name, name))
      .limit(1);
    return rows[0]?.value ?? null;
  }
}
