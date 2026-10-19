/**
 * The neighbourhood of a person's current reading, looked up in the
 * background after it is stored.
 *
 * A lookup is made only while maps are on, someone will see the answer (the
 * owner's Home, agents, or a share that shows it), the reading is not at or
 * near a home place (while skipProviderNearHome is on), and the reading is
 * recent: a late upload of queued points is not worth a provider call. The
 * answer comes from the per-person cache first; otherwise at most one
 * provider call per person every AREA_REFRESH_MIN_MS. A move inside that
 * window drops the old area at once (the ingest already did) and schedules
 * one trailing lookup for when the window ends.
 */

import { haversineMeters } from "../geofence/distance.js";
import type { PrivacySettings, UserId } from "../types.js";
import type { SettingsStore } from "../privacy/settingsStore.js";
import type { PlacesStore } from "../store/placesStore.js";
import type { PresenceStore } from "../store/presenceStore.js";
import type { SharesStore } from "../sharing/sharesStore.js";
import { log } from "../util/log.js";
import { KeyedMutex } from "../util/mutex.js";
import type { Clock } from "../util/time.js";
import { cacheTtlMs, type GeoCacheStore } from "./cacheStore.js";
import { nearHomePlace } from "./eta.js";
import type { GeoKeys } from "./keys.js";
import type { LatLon, ReverseResult } from "./types.js";

/** Look up the area at most this often per person... */
export const AREA_REFRESH_MIN_MS = 120_000;
/** ...and keep it while the person stays this close to where it was looked up. */
export const AREA_REFRESH_MOVE_M = 200;
/** A reading the device took longer ago than this is not looked up. */
export const AREA_MAX_READING_AGE_MS = 5 * 60_000;

/** The area a reading resolved to, or null to clear it. `forPoint`: the reading it was looked up for. */
export type AreaUpdate = { region: ReverseResult | null; forPoint?: LatLon };

/** Run `task` after `ms`; the returned function cancels it. */
export type Schedule = (ms: number, task: () => void) => () => void;

/** A timer that does not keep the process alive. */
export const timerSchedule: Schedule = (ms, task) => {
  const timer = setTimeout(task, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export interface AreaRefresherDeps {
  settings: SettingsStore;
  presence: PresenceStore;
  places: PlacesStore;
  shares: Pick<SharesStore, "showsAreaToAnyone">;
  cache: GeoCacheStore;
  keys: GeoKeys;
  nearRadiusMultiplier: number;
  /** Writes presence city/area under the presence mutex (PresenceService.setArea). */
  setArea: (userId: UserId, update: AreaUpdate) => Promise<void>;
  clock: Clock;
  schedule: Schedule;
}

export class AreaRefresher {
  private readonly mutex = new KeyedMutex();
  /** When each person's area was last looked up at a provider. */
  private readonly lastLookup = new Map<UserId, number>();
  /** Each person's pending trailing lookup, by its cancel function. */
  private readonly trailing = new Map<UserId, () => void>();
  private readonly inFlight = new Set<Promise<void>>();
  private closed = false;

  constructor(private readonly deps: AreaRefresherDeps) {}

  /** Bring the area up to date with the current reading, in the background. Returns at once. */
  refresh(userId: UserId): void {
    if (this.closed) return;
    const run = this.mutex.run(userId, () => this.refreshLocked(userId)).catch((e: unknown) => {
      log.error("area lookup failed", e);
    });
    this.inFlight.add(run);
    void run.finally(() => this.inFlight.delete(run));
  }

  /** Wait for every lookup started so far (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  /** Cancel every trailing lookup, start no more, and wait for those running. */
  async close(): Promise<void> {
    this.closed = true;
    for (const cancel of this.trailing.values()) cancel();
    this.trailing.clear();
    await this.settled();
  }

  /** One trailing lookup per person, however many moves ask for it. */
  private scheduleTrailing(userId: UserId, delayMs: number): void {
    if (this.closed || this.trailing.has(userId)) return;
    const cancel = this.deps.schedule(delayMs, () => {
      this.trailing.delete(userId);
      this.refresh(userId);
    });
    this.trailing.set(userId, cancel);
  }

  private cancelTrailing(userId: UserId): void {
    this.trailing.get(userId)?.();
    this.trailing.delete(userId);
  }

  private async hasConsumer(userId: UserId, settings: PrivacySettings): Promise<boolean> {
    return settings.areaOnHome || settings.areaToAgents || (await this.deps.shares.showsAreaToAnyone(userId));
  }

  private async refreshLocked(userId: UserId): Promise<void> {
    const [settings, presence] = await Promise.all([
      this.deps.settings.getOrSeed(userId),
      this.deps.presence.getCurrent(userId),
    ]);
    const hasArea = presence?.coarse?.area !== undefined || presence?.coarse?.city !== undefined;
    const dropArea = async () => {
      if (hasArea) await this.deps.setArea(userId, { region: null });
    };
    /** Nothing to look up: drop the area, the throttle and any trailing lookup. */
    const stop = async () => {
      this.lastLookup.delete(userId);
      this.cancelTrailing(userId);
      await dropArea();
    };
    if (!settings.geoEnabled) {
      // With maps off nothing about the person's whereabouts is kept for maps.
      await this.deps.cache.purge(userId);
      return stop();
    }
    if (!presence?.precise) return stop();
    const here = presence.precise;
    // Near home nothing is sent; the status already says home.
    const places = await this.deps.places.list(userId);
    if (settings.skipProviderNearHome && nearHomePlace(here, places, this.deps.nearRadiusMultiplier)) return stop();
    if (!(await this.hasConsumer(userId, settings))) return stop();

    const at = presence.areaFor;
    if (hasArea && at && haversineMeters(at.lat, at.lon, here.lat, here.lon) <= AREA_REFRESH_MOVE_M) return;
    const now = this.deps.clock().getTime();
    if (now - Date.parse(presence.updatedAt) > AREA_MAX_READING_AGE_MS) return dropArea();

    const resolved = await this.deps.keys.resolve(userId, settings);
    if (!resolved) return stop();
    const ttlMs = cacheTtlMs(settings.retentionHours);
    const cached = await this.deps.cache.get(userId, resolved.name, here, ttlMs);
    if (cached.hit) {
      await this.deps.setArea(userId, { region: cached.result, forPoint: here });
      return;
    }
    const last = this.lastLookup.get(userId);
    if (last !== undefined && now - last < AREA_REFRESH_MIN_MS) {
      await dropArea();
      this.scheduleTrailing(userId, last + AREA_REFRESH_MIN_MS - now);
      return;
    }
    // Kept even when the call fails, so errors cannot loop.
    this.lastLookup.set(userId, now);
    const looked = await this.deps.keys.call(userId, { kind: "system" }, resolved, "geo.reverse", (p) => p.reverse(here));
    if (looked.kind !== "ok") {
      if (looked.kind === "failed") log.warn("area lookup failed", { provider: resolved.name, kind: looked.error.kind });
      return dropArea();
    }
    await this.deps.cache.put(userId, resolved.name, here, looked.value, ttlMs);
    await this.deps.setArea(userId, { region: looked.value, forPoint: here });
  }
}
