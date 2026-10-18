/**
 * Spent ceremony nonces. A signed ceremony state is accepted once: the first
 * verify inserts its nonce and any replay finds the row already there. Rows
 * outlive the ceremony's own expiry only until the periodic prune.
 */

import { lt } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { usedNonces } from "../db/schema.js";
import { nowIso, type Clock, systemClock } from "../util/time.js";

export class NoncesStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  /** True the first time `nonce` is spent, false on every later attempt. */
  async spend(nonce: string, expiresAt: string): Promise<boolean> {
    const result = await this.db.insert(usedNonces).values({ nonce, expiresAt }).onConflictDoNothing();
    return result.rowsAffected > 0;
  }

  async prune(): Promise<number> {
    const result = await this.db.delete(usedNonces).where(lt(usedNonces.expiresAt, nowIso(this.clock)));
    return result.rowsAffected;
  }
}
