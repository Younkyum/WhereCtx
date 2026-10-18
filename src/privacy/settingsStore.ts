/**
 * Privacy settings repository (plan section 9.3).
 *
 * Precedence (docs/decisions.md): environment seeds a user's row the first time
 * it is read; thereafter the persisted row is authoritative and dashboard edits
 * stick.
 */

import { eq } from "drizzle-orm";
import type { WhereCtxConfig } from "../config.js";
import type { Database } from "../db/index.js";
import { privacySettings } from "../db/schema.js";
import type { PrivacyMode, PrivacySettings, UserId } from "../types.js";
import { nowIso, type Clock, systemClock } from "../util/time.js";

interface SettingsRow {
  userId: string;
  defaultAgentAccess: PrivacyMode;
  allowPreciseLocation: boolean;
  preciseRequiresReason: boolean;
  preciseRequiresApproval: boolean;
  hideHomeExactCoordinates: boolean;
  protectHomePlace: boolean;
  retentionHours: number;
  storeRawHistory: boolean;
  updatedAt: string;
}

function rowToSettings(row: SettingsRow): PrivacySettings {
  return {
    defaultAgentAccess: row.defaultAgentAccess,
    allowPreciseLocation: row.allowPreciseLocation,
    preciseRequiresReason: row.preciseRequiresReason,
    preciseRequiresApproval: row.preciseRequiresApproval,
    hideHomeExactCoordinates: row.hideHomeExactCoordinates,
    protectHomePlace: row.protectHomePlace,
    retentionHours: row.retentionHours,
    storeRawHistory: row.storeRawHistory,
  };
}

export class SettingsStore {
  constructor(
    private readonly db: Database,
    /** Env privacy values seed every user's row on first access. */
    private readonly config: WhereCtxConfig,
    private readonly clock: Clock = systemClock,
  ) {}

  private async find(userId: UserId): Promise<PrivacySettings | null> {
    const rows = (await this.db
      .select()
      .from(privacySettings)
      .where(eq(privacySettings.userId, userId))
      .limit(1)) as SettingsRow[];
    return rows[0] ? rowToSettings(rows[0]) : null;
  }

  /**
   * The user's settings, seeded from config the first time they are read. Every
   * read and write goes through here, so no caller handles a missing row. The
   * insert ignores a conflict, so concurrent first reads converge on one row.
   */
  async getOrSeed(userId: UserId): Promise<PrivacySettings> {
    const existing = await this.find(userId);
    if (existing) return existing;
    const { privacy } = this.config;
    await this.db
      .insert(privacySettings)
      .values({
        userId,
        defaultAgentAccess: privacy.defaultAgentAccess,
        allowPreciseLocation: privacy.allowPreciseToAgent,
        preciseRequiresReason: privacy.preciseRequiresReason,
        preciseRequiresApproval: false,
        hideHomeExactCoordinates: privacy.hideHomeExactCoordinates,
        protectHomePlace: privacy.protectHomePlace,
        retentionHours: privacy.retentionHours,
        storeRawHistory: privacy.storeRawHistory,
        updatedAt: nowIso(this.clock),
      } satisfies SettingsRow)
      .onConflictDoNothing();
    return (await this.find(userId))!;
  }

  async update(userId: UserId, patch: Partial<PrivacySettings>): Promise<PrivacySettings> {
    const merged: PrivacySettings = { ...(await this.getOrSeed(userId)), ...patch };
    await this.db
      .update(privacySettings)
      .set({ ...merged, updatedAt: nowIso(this.clock) })
      .where(eq(privacySettings.userId, userId));
    return merged;
  }
}
