/**
 * Presence service — the framework-agnostic core domain logic.
 *
 * Takes a normalized reading and: computes geofence status, applies motion
 * refinement, derives coarse (geohash) location, persists the new presence,
 * diffs against the previous state to emit events (updated / entered_place /
 * left_place / privacy_changed), optionally records raw history, and fires
 * matching location reminders.
 *
 * Webhook delivery is NOT done here — the service returns the events so the
 * transport layer (Phase 4) can dispatch them. This keeps the core testable.
 */

import type { WhereCtxConfig } from "../config.js";
import { computeGeofence, labelForStatus } from "../geofence/engine.js";
import { encodeGeohash } from "../geofence/distance.js";
import type { NormalizedReading } from "../normalizer/types.js";
import type {
  CoarsePlaceType,
  Place,
  PresenceContext,
  PresenceEvent,
  PresenceStatus,
  PrivacySettings,
} from "../types.js";
import { nowIso, isStale, type Clock, systemClock } from "../util/time.js";
import { KeyedMutex } from "../util/mutex.js";
import type { EventsStore, NewPresenceEvent } from "../store/eventsStore.js";
import type { HistoryStore } from "../store/historyStore.js";
import type { PlacesStore } from "../store/placesStore.js";
import {
  type PresenceStore,
  type StoredPresence,
  toPresenceContext,
} from "../store/presenceStore.js";
import type { Reminder, RemindersStore } from "../store/remindersStore.js";
import type { SettingsStore } from "../privacy/settingsStore.js";

export interface PresenceServiceDeps {
  config: WhereCtxConfig;
  presenceStore: PresenceStore;
  placesStore: PlacesStore;
  eventsStore: EventsStore;
  historyStore: HistoryStore;
  remindersStore: RemindersStore;
  settingsStore: SettingsStore;
  clock?: Clock;
}

export interface ProcessResult {
  presence: PresenceContext;
  events: PresenceEvent[];
  triggeredReminders: Reminder[];
}

function coarsePlaceTypeFor(place: Place | undefined): CoarsePlaceType | undefined {
  if (!place) return undefined;
  if (place.type === "home") return "home";
  if (place.type === "work") return "work";
  return "unknown";
}

export class PresenceService {
  private readonly clock: Clock;
  private readonly mutex = new KeyedMutex();

  constructor(private readonly deps: PresenceServiceDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  private get userId(): string {
    return this.deps.config.userId;
  }

  /**
   * Process a normalized reading. Serialized per user so overlapping ingests
   * cannot race the read-diff-write sequence (review finding F10).
   */
  async processReading(reading: NormalizedReading): Promise<ProcessResult> {
    return this.mutex.run(this.userId, () => this.processReadingLocked(reading));
  }

  /** Settings with the (defensive) first-boot seed fallback. */
  private async getSettings(userId: string): Promise<PrivacySettings> {
    return (
      (await this.deps.settingsStore.get(userId)) ??
      (await this.deps.settingsStore.seedFromConfig(userId, this.deps.config))
    );
  }

  private async processReadingLocked(reading: NormalizedReading): Promise<ProcessResult> {
    const { config } = this.deps;
    const userId = this.userId;

    // Independent reads — fetch concurrently to keep the mutex hold time down
    // on slow storage (review P5).
    const [settings, places, prev] = await Promise.all([
      this.getSettings(userId),
      this.deps.placesStore.list(userId),
      this.deps.presenceStore.getCurrent(userId),
    ]);

    const geo = computeGeofence(
      reading.precise.lat,
      reading.precise.lon,
      places,
      config.geofence.nearRadiusMultiplier,
    );

    // Motion refinement: someone who is "away" but clearly moving is in transit.
    let status: PresenceStatus = geo.status;
    let label = geo.label;
    if (status === "away" && (reading.motion === "driving" || reading.motion === "transit")) {
      status = "transit";
      label = labelForStatus("transit");
    }

    const next: StoredPresence = {
      userId,
      status,
      label,
      precise: reading.precise,
      coarse: {
        geohash: encodeGeohash(reading.precise.lat, reading.precise.lon),
        placeType: coarsePlaceTypeFor(geo.matchedPlace),
      },
      motion: reading.motion ?? "unknown",
      battery: reading.battery,
      source: reading.source,
      privacy: {
        mode: settings.defaultAgentAccess,
        allowPreciseToAgents: settings.allowPreciseLocation,
      },
      updatedAt: reading.updatedAt,
      receivedAt: nowIso(this.clock),
      staleAfterSec: config.privacy.staleAfterSec,
      currentPlaceName: geo.matchedPlace?.name,
      staleEventFired: false,
    };

    await this.deps.presenceStore.upsert(next);

    const events = await this.emitTransitionEvents(prev, next);

    // Raw history (opt-in) + retention pruning.
    if (settings.storeRawHistory) {
      await this.deps.historyStore.append(userId, {
        lat: reading.precise.lat,
        lon: reading.precise.lon,
        accuracyM: reading.precise.accuracyM,
        source: reading.source,
        recordedAt: reading.updatedAt,
      });
      await this.deps.historyStore.prune(userId, settings.retentionHours);
    }

    // Fire reminders attached to a newly-entered place.
    const triggeredReminders = await this.fireReminders(prev, next);

    return {
      presence: toPresenceContext(next),
      events,
      triggeredReminders,
    };
  }

  private async emitTransitionEvents(
    prev: StoredPresence | null,
    next: StoredPresence,
  ): Promise<PresenceEvent[]> {
    const pending: NewPresenceEvent[] = [];

    pending.push({
      type: "presence.updated",
      status: next.status,
      source: next.source,
      placeName: next.currentPlaceName,
    });

    const prevPlace = prev?.currentPlaceName;
    const nextPlace = next.currentPlaceName;
    if (prevPlace !== nextPlace) {
      if (prevPlace) {
        pending.push({ type: "presence.left_place", placeName: prevPlace, status: next.status, source: next.source });
      }
      if (nextPlace) {
        pending.push({ type: "presence.entered_place", placeName: nextPlace, status: next.status, source: next.source });
      }
    }

    if (prev && prev.privacy.mode !== next.privacy.mode) {
      pending.push({ type: "presence.privacy_changed", status: next.status });
    }

    // Single batched INSERT — up to 3 events per reading, inside the mutex (P1).
    return this.deps.eventsStore.appendMany(pending);
  }

  private async fireReminders(
    prev: StoredPresence | null,
    next: StoredPresence,
  ): Promise<Reminder[]> {
    const nextPlace = next.currentPlaceName;
    if (!nextPlace || prev?.currentPlaceName === nextPlace) return [];
    const reminders = await this.deps.remindersStore.listActiveForPlace(nextPlace);
    await this.deps.remindersStore.markTriggeredBatch(reminders.map((r) => r.id));
    return reminders;
  }

  /**
   * Time-based staleness check. If the current reading is stale and no
   * `presence.became_stale` has fired yet, emit one (once). Intended to be
   * called on read and/or by a periodic sweep. Serialized with ingest so the
   * stale flag does not race a concurrent upsert (F10/F13).
   */
  async checkStale(): Promise<PresenceEvent | null> {
    return this.mutex.run(this.userId, async () => {
      const userId = this.userId;
      const current = await this.deps.presenceStore.getCurrent(userId);
      if (!current) return null;
      const stale = isStale(current.updatedAt, current.staleAfterSec, this.clock);
      if (!stale || current.staleEventFired) return null;
      await this.deps.presenceStore.setStaleEventFired(userId, true);
      return this.deps.eventsStore.append({
        type: "presence.became_stale",
        status: current.status,
        source: current.source,
      });
    });
  }

  /**
   * Re-evaluate the current presence against the latest set of places, reusing
   * the last known coordinate. Status is computed at ingest time and then frozen
   * on the stored row, so adding/moving/removing a place does NOT change the
   * displayed status until the next location reading arrives — e.g. registering
   * "work" while standing at work but still reading "away". Callers (the places
   * API) invoke this after a place change and dispatch the returned events.
   * Returns null when there is no current location to re-evaluate. Serialized
   * per user so it cannot race a concurrent ingest.
   */
  async reevaluateCurrent(): Promise<ProcessResult | null> {
    return this.mutex.run(this.userId, async () => {
      const userId = this.userId;
      const prev = await this.deps.presenceStore.getCurrent(userId);
      if (!prev?.precise) return null;

      const places = await this.deps.placesStore.list(userId);
      const geo = computeGeofence(
        prev.precise.lat,
        prev.precise.lon,
        places,
        this.deps.config.geofence.nearRadiusMultiplier,
      );

      // Same motion refinement as processReadingLocked.
      let status: PresenceStatus = geo.status;
      let label = geo.label;
      if (status === "away" && (prev.motion === "driving" || prev.motion === "transit")) {
        status = "transit";
        label = labelForStatus("transit");
      }

      const nextPlaceName = geo.matchedPlace?.name;
      // No change → nothing to persist or emit.
      if (status === prev.status && nextPlaceName === prev.currentPlaceName) {
        return { presence: toPresenceContext(prev), events: [], triggeredReminders: [] };
      }

      const next: StoredPresence = {
        ...prev,
        status,
        label,
        coarse: {
          ...prev.coarse,
          placeType: coarsePlaceTypeFor(geo.matchedPlace),
        },
        currentPlaceName: nextPlaceName,
      };

      await this.deps.presenceStore.upsert(next);
      const events = await this.emitTransitionEvents(prev, next);
      const triggeredReminders = await this.fireReminders(prev, next);
      return { presence: toPresenceContext(next), events, triggeredReminders };
    });
  }

  /**
   * Apply a privacy-settings change and emit `presence.privacy_changed`
   * (review finding F7 — previously this event only fired incidentally on the
   * next ingest). Updates the current presence row's privacy snapshot too so a
   * tightened mode takes effect immediately. Serialized per user.
   */
  async changePrivacySettings(
    patch: Partial<PrivacySettings>,
  ): Promise<{ settings: PrivacySettings; event: PresenceEvent | null }> {
    return this.mutex.run(this.userId, async () => {
      const userId = this.userId;

      const before = await this.getSettings(userId);
      const after =
        (await this.deps.settingsStore.update(userId, patch)) ?? before;

      const modeChanged = before.defaultAgentAccess !== after.defaultAgentAccess;

      const current = await this.deps.presenceStore.getCurrent(userId);
      if (current) {
        await this.deps.presenceStore.setPrivacy(
          userId,
          after.defaultAgentAccess,
          after.allowPreciseLocation,
        );
      }

      let event: PresenceEvent | null = null;
      if (modeChanged) {
        event = await this.deps.eventsStore.append({
          type: "presence.privacy_changed",
          status: current?.status,
        });
      }
      return { settings: after, event };
    });
  }
}
