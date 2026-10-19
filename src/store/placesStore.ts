/**
 * Places / geofences repository (plan section 9.5 / 10.2).
 * All queries are scoped to a userId.
 */

import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { places } from "../db/schema.js";
import { DEFAULT_PLACE_RULES, type Place, type PlaceRules, type PlaceType, type Ring, type UserId } from "../types.js";
import { nowIso, type Clock, systemClock } from "../util/time.js";

/**
 * A place to write. `lat`, `lon` and `radiusM` are the anchor circle; with a
 * `polygon` they must be its centroid and circumradius (validatePolygon gives
 * them), and without one the place is that circle. Rules left out keep what
 * the place has (defaults for a new place); the geometry and label are
 * always replaced.
 */
export interface PlaceInput extends Partial<PlaceRules> {
  name: string;
  label?: string;
  lat: number;
  lon: number;
  radiusM: number;
  polygon?: Ring;
  type: PlaceType;
}

type PlaceRow = typeof places.$inferSelect;

function rowToPlace(row: PlaceRow): Place {
  return {
    id: row.id,
    name: row.name,
    label: row.label ?? undefined,
    lat: row.lat,
    lon: row.lon,
    radiusM: row.radiusM,
    ...(row.polygon ? { polygon: row.polygon } : {}),
    type: row.type,
    enterAfterSec: row.enterAfterSec,
    exitAfterSec: row.exitAfterSec,
    approachM: row.approachM,
    emits: row.emits ?? [...DEFAULT_PLACE_RULES.emits],
    notifyWebhooks: row.notifyWebhooks,
    notifyReminders: row.notifyReminders,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The rule columns `input` sets; a rule it leaves out is not written. */
function ruleColumns(input: Partial<PlaceRules>): Partial<PlaceRow> {
  return {
    ...(input.enterAfterSec === undefined ? {} : { enterAfterSec: input.enterAfterSec }),
    ...(input.exitAfterSec === undefined ? {} : { exitAfterSec: input.exitAfterSec }),
    ...(input.approachM === undefined ? {} : { approachM: input.approachM }),
    ...(input.emits === undefined ? {} : { emits: [...new Set(input.emits)] }),
    ...(input.notifyWebhooks === undefined ? {} : { notifyWebhooks: input.notifyWebhooks }),
    ...(input.notifyReminders === undefined ? {} : { notifyReminders: input.notifyReminders }),
  };
}

export class PlacesStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  async list(userId: UserId): Promise<Place[]> {
    const rows = await this.db.select().from(places).where(eq(places.userId, userId));
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
    const rows = await this.db
      .select()
      .from(places)
      .where(and(eq(places.userId, userId), eq(places.name, name)))
      .limit(1);
    return rows[0] ? rowToPlace(rows[0]) : null;
  }

  /** Create or replace a place by name (upsert on the (userId,name) unique key). */
  async upsert(userId: UserId, input: PlaceInput): Promise<Place> {
    const ts = nowIso(this.clock);
    const replaced = {
      label: input.label ?? null,
      lat: input.lat,
      lon: input.lon,
      radiusM: input.radiusM,
      polygon: input.polygon ?? null,
      type: input.type,
      ...ruleColumns(input),
      updatedAt: ts,
    };
    const owned = and(eq(places.userId, userId), eq(places.name, input.name));
    const updated = await this.db.update(places).set(replaced).where(owned);
    if ((updated.rowsAffected ?? 0) === 0) {
      await this.db.insert(places).values({
        id: randomBytes(16).toString("hex"),
        userId,
        name: input.name,
        ...replaced,
        createdAt: ts,
      });
    }
    const [row] = await this.db.select().from(places).where(owned).limit(1);
    return rowToPlace(row!);
  }

  async deleteByName(userId: UserId, name: string): Promise<boolean> {
    const result = await this.db
      .delete(places)
      .where(and(eq(places.userId, userId), eq(places.name, name)));
    return (result.rowsAffected ?? 0) > 0;
  }
}
