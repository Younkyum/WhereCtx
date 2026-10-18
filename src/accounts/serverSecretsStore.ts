/**
 * Per-install secrets kept in the database, so every instance sharing it
 * agrees: the key that signs WebAuthn ceremony state, and the hash of the
 * first-owner setup code.
 */

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { serverSecrets } from "../db/schema.js";
import { nowIso, type Clock, systemClock } from "../util/time.js";

const CEREMONY_KEY = "ceremony_key";
const SETUP_CODE_HASH = "setup_code_hash";

export class ServerSecretsStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * The ceremony signing key, created on first boot. Insert-if-absent then
   * read, so instances booting together converge on one key.
   */
  async ceremonyKey(): Promise<Buffer> {
    await this.db
      .insert(serverSecrets)
      .values({
        name: CEREMONY_KEY,
        value: randomBytes(32).toString("base64url"),
        createdAt: nowIso(this.clock),
      })
      .onConflictDoNothing();
    const value = await this.get(CEREMONY_KEY);
    return Buffer.from(value!, "base64url");
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

  private async get(name: string): Promise<string | null> {
    const rows = await this.db
      .select({ value: serverSecrets.value })
      .from(serverSecrets)
      .where(eq(serverSecrets.name, name))
      .limit(1);
    return rows[0]?.value ?? null;
  }
}
