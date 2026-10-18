/**
 * Single-use recovery codes: the way back in after losing every passkey.
 * A user holds one set of 8 at a time; regenerating replaces the whole set.
 *
 * A code is `LOOKUP-SECRET`: a 6-character public lookup id that finds the
 * row, then 24 secret characters (~117 bits) of which only the SHA-256 is
 * stored and compared in constant time. The lookup id gives each code its own
 * failure counter (the route throttles per lookup id), and the secret's
 * entropy makes guessing hopeless even across every stored code.
 */

import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { recoveryCodes } from "../db/schema.js";
import {
  CODE_ALPHABET,
  groupCode,
  hashToken,
  newId,
  normalizeCode,
  randomCodeChars,
  secretsEqual,
} from "../auth/secrets.js";
import { asUserId, type UserId } from "../types.js";
import { nowIso, type Clock, systemClock } from "../util/time.js";

export const RECOVERY_CODE_COUNT = 8;
const LOOKUP_LENGTH = 6;
const SECRET_LENGTH = 24;
const GROUP = 6;
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${LOOKUP_LENGTH + SECRET_LENGTH}}$`);

export interface ParsedRecoveryCode {
  lookupId: string;
  secret: string;
}

/** Split a typed code into its parts, or null if it cannot be a recovery code. */
export function parseRecoveryCode(input: string): ParsedRecoveryCode | null {
  const chars = normalizeCode(input);
  if (!CODE_PATTERN.test(chars)) return null;
  return { lookupId: chars.slice(0, LOOKUP_LENGTH), secret: chars.slice(LOOKUP_LENGTH) };
}

export class RecoveryStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Replace the user's codes with a fresh set; the plaintext is returned once. */
  async regenerate(userId: UserId): Promise<string[]> {
    const parts = Array.from({ length: RECOVERY_CODE_COUNT }, () => ({
      lookupId: randomCodeChars(LOOKUP_LENGTH),
      secret: randomCodeChars(SECRET_LENGTH),
    }));
    await this.db.batch([
      this.db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)),
      this.db.insert(recoveryCodes).values(
        parts.map(({ lookupId, secret }) => ({
          id: newId(),
          userId,
          lookupId,
          secretHash: hashToken(secret),
          usedAt: null,
        })),
      ),
    ]);
    return parts.map(({ lookupId, secret }) => groupCode(lookupId + secret, GROUP));
  }

  /** Spend a code. Returns its owner, or null if unknown, wrong, or already used. */
  async consume(code: ParsedRecoveryCode): Promise<UserId | null> {
    const candidates = await this.db
      .select({ id: recoveryCodes.id, secretHash: recoveryCodes.secretHash })
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.lookupId, code.lookupId), isNull(recoveryCodes.usedAt)));
    const presented = hashToken(code.secret);
    const match = candidates.find((c) => secretsEqual(c.secretHash, presented));
    if (!match) return null;
    // The guard on used_at makes a concurrent second spend of the same code miss.
    const rows = await this.db
      .update(recoveryCodes)
      .set({ usedAt: nowIso(this.clock) })
      .where(and(eq(recoveryCodes.id, match.id), isNull(recoveryCodes.usedAt)))
      .returning({ userId: recoveryCodes.userId });
    return rows[0] ? asUserId(rows[0].userId) : null;
  }
}
