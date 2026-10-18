/**
 * Places / geofences repository (plan section 9.5 / 10.2).
 * All queries are scoped to a userId.
 */

import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { places } from "../db/schema.js";
import type { Place, PlaceType, UserId } from "../types.js";
import { nowIso, type Clock, systemClock } from "../util/time.js";

export interface PlaceInput {
  name: string;
  label?: string;
  lat: number;
  lon: number;
  radiusM: number;
  type: PlaceType;
}

interface PlaceRow {
  id: string;
  userId: string;
  name: string;
  label: string | null;
  lat: number;
  lon: number;
  radiusM: number;
  type: PlaceType;
  createdAt: string;
  updatedAt: string;
}

function rowToPlace(row: PlaceRow): Place {
  return {
    id: row.id,
    name: row.name,
    label: row.label ?? undefined,
    lat: row.lat,
    lon: row.lon,
    radiusM: row.radiusM,
    type: row.type,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PlacesStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  async list(userId: UserId): Promise<Place[]> {
    const rows = (await this.db
      .select()
      .from(places)
      .where(eq(places.userId, userId))) as PlaceRow[];
    return rows.map(rowToPlace);
  }

  async count(userId: UserId): Promise<number> {
    const rows = (await this.db
      .select({ c: sql<number>`count(*)` })
      .from(places)
      .where(eq(places.userId, userId))) as Array<{ c: number }>;
    return rows[0]?.c ?? 0;
  }

  async get(userId: UserId, name: string): Promise<Place | null> {
    const rows = (await this.db
      .select()
      .from(places)
      .where(and(eq(places.userId, userId), eq(places.name, name)))
      .limit(1)) as PlaceRow[];
    return rows[0] ? rowToPlace(rows[0]) : null;
  }

  /** Create or replace a place by name (upsert on the (userId,name) unique key). */
  async upsert(userId: UserId, input: PlaceInput): Promise<Place> {
    const existing = await this.get(userId, input.name);
    const ts = nowIso(this.clock);
    if (existing) {
      const row: Partial<PlaceRow> = {
        label: input.label ?? null,
        lat: input.lat,
        lon: input.lon,
        radiusM: input.radiusM,
        type: input.type,
        updatedAt: ts,
      };
      await this.db
        .update(places)
        .set(row)
        .where(and(eq(places.userId, userId), eq(places.name, input.name)));
      return { ...existing, ...input, updatedAt: ts };
    }
    const record: PlaceRow = {
      id: randomBytes(16).toString("hex"),
      userId,
      name: input.name,
      label: input.label ?? null,
      lat: input.lat,
      lon: input.lon,
      radiusM: input.radiusM,
      type: input.type,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.db.insert(places).values(record);
    return rowToPlace(record);
  }

  async deleteByName(userId: UserId, name: string): Promise<boolean> {
    const result = await this.db
      .delete(places)
      .where(and(eq(places.userId, userId), eq(places.name, name)));
    return (result.rowsAffected ?? 0) > 0;
  }
}
