/**
 * Operator break-glass: `reset-access <userId>` stores a one-time access code
 * for one user (hashed, 1 hour), and redeeming it registers a new passkey for
 * that user. A user holds at most one code; issuing replaces it.
 */

import { Secret } from "../util/secret.js";
import { and, eq, gt, lt } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { accessCodes } from "../db/schema.js";
import { generateCode, hashToken, normalizeCode } from "../auth/secrets.js";
import { asUserId, type UserId } from "../types.js";
import { nowIso, type Clock, systemClock } from "../util/time.js";
import type { NewPasskey, PasskeysStore } from "./passkeysStore.js";

export const ACCESS_CODE_TTL_MS = 3600_000;

/** The stored form of a typed access code. */
export function accessCodeHash(code: string): string {
  return hashToken(normalizeCode(code));
}

export class AccessCodesStore {
  constructor(
    private readonly db: Database,
    private readonly passkeys: PasskeysStore,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Issue a fresh code for `userId`; the plaintext is returned once. */
  async issue(userId: UserId): Promise<{ code: Secret; expiresAt: string }> {
    const code = generateCode(4, 6);
    const now = this.clock();
    const row = {
      userId,
      codeHash: accessCodeHash(code),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ACCESS_CODE_TTL_MS).toISOString(),
    };
    await this.db
      .insert(accessCodes)
      .values(row)
      .onConflictDoUpdate({ target: accessCodes.userId, set: row });
    return { code: new Secret(code), expiresAt: row.expiresAt };
  }

  /** The user a live code was issued for, or null. */
  async find(codeHash: string): Promise<UserId | null> {
    const rows = await this.db
      .select({ userId: accessCodes.userId })
      .from(accessCodes)
      .where(this.live(codeHash))
      .limit(1);
    return rows[0] ? asUserId(rows[0].userId) : null;
  }

  /**
   * Spend the code on a new passkey for `userId`. The passkey insert is
   * conditioned on the code still being live and the code is deleted in the
   * same transaction, so two redemptions racing store exactly one passkey.
   */
  async redeem(userId: UserId, codeHash: string, passkey: NewPasskey): Promise<boolean> {
    const live = and(this.live(codeHash), eq(accessCodes.userId, userId))!;
    const [stored] = await this.db.batch([
      this.passkeys.insertWhen(userId, passkey, nowIso(this.clock), { from: accessCodes, where: live }),
      this.db.delete(accessCodes).where(live),
    ]);
    return stored.rowsAffected > 0;
  }

  async prune(): Promise<number> {
    const result = await this.db.delete(accessCodes).where(lt(accessCodes.expiresAt, nowIso(this.clock)));
    return result.rowsAffected;
  }

  private live(codeHash: string) {
    return and(eq(accessCodes.codeHash, codeHash), gt(accessCodes.expiresAt, nowIso(this.clock)))!;
  }
}
