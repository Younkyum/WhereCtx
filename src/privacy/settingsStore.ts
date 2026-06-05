/**
 * Privacy settings repository (plan section 9.3).
 *
 * Precedence (docs/decisions.md): environment seeds the row on first boot;
 * thereafter the persisted row is authoritative and dashboard edits stick.
 */

import { eq } from "drizzle-orm";
import type { WhereCtxConfig } from "../config.js";
import type { Database } from "../db/index.js";
import { privacySettings } from "../db/schema.js";
import type { PrivacyMode, PrivacySettings } from "../types.js";
import { nowIso, type Clock, systemClock } from "../util/time.js";

interface SettingsRow {
  userId: string;
  defaultAgentAccess: PrivacyMode;
  allowPreciseLocation: boolean;
  preciseRequiresReason: boolean;
  preciseRequiresApproval: boolean;
  hideHomeExactCoordinates: boolean;
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
    retentionHours: row.retentionHours,
    storeRawHistory: row.storeRawHistory,
  };
}

export class SettingsStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  async get(userId: string): Promise<PrivacySettings | null> {
    const rows = (await this.db
      .select()
      .from(privacySettings)
      .where(eq(privacySettings.userId, userId))
      .limit(1)) as SettingsRow[];
    return rows[0] ? rowToSettings(rows[0]) : null;
  }

  /** Insert the settings row from config on first boot. No-op if it exists. */
  async seedFromConfig(userId: string, config: WhereCtxConfig): Promise<PrivacySettings> {
    const existing = await this.get(userId);
    if (existing) return existing;
    const row: SettingsRow = {
      userId,
      defaultAgentAccess: config.privacy.defaultAgentAccess,
      allowPreciseLocation: config.privacy.allowPreciseToAgent,
      preciseRequiresReason: config.privacy.preciseRequiresReason,
      preciseRequiresApproval: false,
      hideHomeExactCoordinates: config.privacy.hideHomeExactCoordinates,
      retentionHours: config.privacy.retentionHours,
      storeRawHistory: config.privacy.storeRawHistory,
      updatedAt: nowIso(this.clock),
    };
    await this.db.insert(privacySettings).values(row);
    return rowToSettings(row);
  }

  async update(
    userId: string,
    patch: Partial<PrivacySettings>,
  ): Promise<PrivacySettings | null> {
    const existing = await this.get(userId);
    if (!existing) return null;
    const merged: PrivacySettings = { ...existing, ...patch };
    await this.db
      .update(privacySettings)
      .set({ ...merged, updatedAt: nowIso(this.clock) })
      .where(eq(privacySettings.userId, userId));
    return merged;
  }
}
