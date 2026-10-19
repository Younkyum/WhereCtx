/**
 * Presence service — the framework-agnostic core domain logic.
 *
 * Takes a normalized reading and: finds the place it is inside (the raw
 * geofence verdict), steps the dwell rules to the confirmed place
 * (geofence/dwell.ts), takes the status from the confirmed place, applies
 * motion refinement, derives coarse (geohash) location, checks approach
 * rings, persists the new presence, emits events (updated / entered_place /
 * left_place / approaching_place / privacy_changed) as each place's rules
 * allow, optionally records raw history, and fires matching location
 * reminders. A pending enter or leave is confirmed later by `sweepDwell`.
 *
 * Webhook delivery is NOT done here — the service returns the events so the
 * transport layer (Phase 4) can dispatch them. This keeps the core testable.
 */

import type { WhereCtxConfig } from "../config.js";
import { computeGeofence, labelForStatus, statusFor } from "../geofence/engine.js";
import { encodeGeohash, haversineMeters } from "../geofence/distance.js";
import { approach } from "../geofence/approach.js";
import { insidePlace, nearHomePlace } from "../geofence/shape.js";
import { step, type DwellState, type DwellTransition } from "../geofence/dwell.js";
import { AREA_REFRESH_MOVE_M, type AreaUpdate } from "../geo/area.js";
import type { NormalizedReading } from "../normalizer/types.js";
import {
  DEFAULT_PLACE_RULES,
  type CoarsePlaceType,
  type Motion,
  type Place,
  type PlaceEventType,
  type PlaceRules,
  type PresenceContext,
  type PresenceEvent,
  type PresenceStatus,
  type PrivacySettings,
  type UserId,
} from "../types.js";
import { type Clock, systemClock } from "../util/time.js";
import { KeyedMutex } from "../util/mutex.js";
import { arrivalFor, isPastWindow, offlineAfterSec } from "./freshness.js";
import type { EventsStore, NewPresenceEvent } from "../store/eventsStore.js";
import type { HistoryStore } from "../store/historyStore.js";
import type { PlacesStore } from "../store/placesStore.js";
import {
  type PresenceStore,
  type StoredPresence,
  dwellFields,
  dwellOf,
  toPresenceContext,
} from "../store/presenceStore.js";
import type { Reminder, RemindersStore } from "../store/remindersStore.js";
import type { SettingsStore } from "../privacy/settingsStore.js";
import { log } from "../util/log.js";

export interface PresenceServiceDeps {
  config: WhereCtxConfig;
  presenceStore: PresenceStore;
  placesStore: PlacesStore;
  eventsStore: EventsStore;
  historyStore: HistoryStore;
  remindersStore: RemindersStore;
  settingsStore: SettingsStore;
  clock?: Clock;
  /**
   * Called once a reading is stored, or the places it is judged against
   * change, and the lock released, to bring its area up to date in the
   * background (GeoService.refreshArea). Must not throw.
   */
  afterReading?: (userId: UserId) => void;
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

/** No enter with a delay is confirmed while the latest reading looks like driving past. */
const DRIVE_BY_SPEED_MPS = 3;

function drivingBy(motion: Motion | undefined, speedMps: number | undefined): boolean {
  return motion === "driving" || motion === "transit" || (speedMps ?? 0) > DRIVE_BY_SPEED_MPS;
}

/**
 * A place that no longer exists is quiet: its rules are gone, and it may
 * have been quiet, so its leave is recorded but never reaches a webhook.
 */
const GONE_PLACE_RULES: PlaceRules = { ...DEFAULT_PLACE_RULES, notifyWebhooks: false };

/** The rules of a place by name; a deleted place is quiet. */
function rulesIn(places: readonly Place[]): (name: string) => PlaceRules {
  const byName = new Map(places.map((p) => [p.name, p]));
  return (name) => byName.get(name) ?? GONE_PLACE_RULES;
}

/** Where a position stands after a dwell step: the confirmed place's status, refined by motion. */
interface Verdict {
  dwell: DwellState;
  transitions: DwellTransition[];
  confirmed: Place | undefined;
  status: PresenceStatus;
  label: string;
}

/** The pending enter, pending leave, approached places and home flag, compared to skip writes that change nothing. */
const bookkeeping = (p: StoredPresence): string =>
  JSON.stringify([p.pendingExitSince ?? null, p.pendingPlace ?? null, p.approachedPlaces ?? [], p.atOrNearHome]);

export class PresenceService {
  private readonly clock: Clock;
  private readonly mutex = new KeyedMutex();

  constructor(private readonly deps: PresenceServiceDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * Process a normalized reading. Serialized per user so overlapping ingests
   * cannot race the read-diff-write sequence (review finding F10).
   */
  async processReading(userId: UserId, reading: NormalizedReading): Promise<ProcessResult> {
    const result = await this.mutex.run(userId, () => this.processReadingLocked(userId, reading));
    this.deps.afterReading?.(userId);
    return result;
  }

  /**
   * Set the region names of the current reading, or clear them. A lookup made
   * for an earlier reading is dropped once the person has moved on from it.
   */
  async setArea(userId: UserId, update: AreaUpdate): Promise<void> {
    await this.mutex.run(userId, async () => {
      const current = await this.deps.presenceStore.getCurrent(userId);
      if (!current) return;
      const { region, forPoint } = update;
      if (region && forPoint) {
        const here = current.precise;
        if (!here || haversineMeters(here.lat, here.lon, forPoint.lat, forPoint.lon) > AREA_REFRESH_MOVE_M) return;
      }
      await this.deps.presenceStore.setArea(userId, region && forPoint ? { city: region.region2, area: region.label, forPoint } : null);
    });
  }

  private async processReadingLocked(
    userId: UserId,
    reading: NormalizedReading,
  ): Promise<ProcessResult> {
    const { config } = this.deps;

    // Independent reads — fetch concurrently to keep the mutex hold time down
    // on slow storage (review P5).
    const [settings, places, prev] = await Promise.all([
      this.deps.settingsStore.getOrSeed(userId),
      this.deps.placesStore.list(userId),
      this.deps.presenceStore.getCurrent(userId),
    ]);

    const now = this.clock();
    const verdict = this.judge({ point: reading.precise, motion: reading.motion, places, dwell: dwellOf(prev), now });
    const { status, label } = verdict;
    const approached = approach({
      places,
      approached: prev?.approachedPlaces ?? [],
      prev: prev?.precise && { ...prev.precise, receivedAt: prev.receivedAt },
      now: { ...reading.precise, motion: reading.motion },
      at: now,
      confirmed: verdict.dwell.current,
      candidate: verdict.dwell.candidate?.name ?? null,
    });

    const receivedAt = now.toISOString();
    const areaFor = prev?.areaFor;
    const areaStillHolds =
      prev !== null &&
      areaFor !== undefined &&
      haversineMeters(areaFor.lat, areaFor.lon, reading.precise.lat, reading.precise.lon) <= AREA_REFRESH_MOVE_M;
    const next: StoredPresence = {
      userId,
      status,
      label,
      precise: reading.precise,
      coarse: {
        geohash: encodeGeohash(reading.precise.lat, reading.precise.lon),
        placeType: coarsePlaceTypeFor(verdict.confirmed),
        // Kept while the reading is near the point it was looked up for; the
        // background lookup (afterReading) confirms or replaces it.
        ...(areaStillHolds ? { city: prev.coarse?.city, area: prev.coarse?.area } : {}),
      },
      ...(areaStillHolds ? { areaFor: prev.areaFor } : {}),
      motion: reading.motion ?? "unknown",
      battery: reading.battery,
      source: reading.source,
      privacy: {
        mode: settings.defaultAgentAccess,
        allowPreciseToAgents: settings.allowPreciseLocation,
      },
      updatedAt: reading.updatedAt,
      receivedAt,
      ...arrivalFor(prev, reading.precise, receivedAt),
      atOrNearHome: this.atOrNearHome(reading.precise, places),
      staleAfterSec: offlineAfterSec(reading.source, config.privacy),
      ...dwellFields(verdict.dwell),
      approachedPlaces: approached.approached,
      staleEventFired: false,
    };

    await this.deps.presenceStore.upsert(next);

    const events = await this.emitEvents(userId, prev, next, places, verdict.transitions, approached.fired);

    // Raw history (opt-in). Pruning runs either way, so points kept before
    // history was turned off still age out.
    if (settings.storeRawHistory) {
      await this.deps.historyStore.append(userId, {
        lat: reading.precise.lat,
        lon: reading.precise.lon,
        accuracyM: reading.precise.accuracyM,
        source: reading.source,
        recordedAt: reading.updatedAt,
      });
    }
    await this.deps.historyStore.prune(userId, settings.retentionHours);

    // Fire reminders attached to a newly-entered place.
    const triggeredReminders = await this.fireReminders(userId, places, verdict.transitions);

    return {
      presence: toPresenceContext(next),
      events,
      triggeredReminders,
    };
  }

  /**
   * Step the dwell rules for the latest point (a new reading's, or the
   * stored one on a sweep or a place change) against the places as they are
   * now, and take the status from the confirmed place.
   */
  private judge(args: {
    point: { lat: number; lon: number; speedMps?: number };
    motion: Motion | undefined;
    places: Place[];
    dwell: DwellState;
    now: Date;
  }): Verdict {
    const geo = computeGeofence(args.point.lat, args.point.lon, args.places, this.deps.config.geofence.nearRadiusMultiplier);
    const byName = new Map(args.places.map((p) => [p.name, p]));
    const current = args.dwell.current === null ? undefined : byName.get(args.dwell.current);
    const stepped = step(
      args.dwell,
      {
        raw: geo.matchedPlace?.name ?? null,
        insideCurrent: current !== undefined && insidePlace(current, args.point.lat, args.point.lon),
        drivingBy: drivingBy(args.motion, args.point.speedMps),
      },
      args.now,
      (name) => byName.get(name),
    );
    const confirmed = stepped.state.current === null ? undefined : byName.get(stepped.state.current);
    let { status, label } = statusFor(confirmed, geo.outside);
    // Motion refinement: someone who is "away" but clearly moving is in transit.
    if (status === "away" && (args.motion === "driving" || args.motion === "transit")) {
      status = "transit";
      label = labelForStatus("transit");
    }
    return { dwell: stepped.state, transitions: stepped.transitions, confirmed, status, label };
  }

  private atOrNearHome(point: { lat: number; lon: number }, places: readonly Place[]): boolean {
    return nearHomePlace(point, places, this.deps.config.geofence.nearRadiusMultiplier) !== null;
  }

  /**
   * Record this step's events. Each place event is recorded only when its
   * place emits that type, and is kept from webhooks when the place has
   * notifyWebhooks off; so is `presence.updated` while inside such a place,
   * since it names the place too. A deleted place is quiet.
   */
  private async emitEvents(
    userId: UserId,
    prev: StoredPresence | null,
    next: StoredPresence,
    places: readonly Place[],
    transitions: readonly DwellTransition[],
    approached: readonly Place[],
  ): Promise<PresenceEvent[]> {
    const rules = rulesIn(places);
    const common = { status: next.status, source: next.source };
    const pending: NewPresenceEvent[] = [];

    const here = next.currentPlaceName;
    pending.push({
      type: "presence.updated",
      ...common,
      placeName: here,
      ...(here && !rules(here).notifyWebhooks ? { webhook: false } : {}),
    });

    const placeEvent = (type: PlaceEventType, name: string): void => {
      const r = rules(name);
      if (!r.emits.includes(type)) return;
      pending.push({ type, placeName: name, ...common, ...(r.notifyWebhooks ? {} : { webhook: false }) });
    };
    for (const t of transitions) placeEvent(t.kind === "left" ? "presence.left_place" : "presence.entered_place", t.name);
    for (const place of approached) placeEvent("presence.approaching_place", place.name);

    if (prev && prev.privacy.mode !== next.privacy.mode) {
      pending.push({ type: "presence.privacy_changed", status: next.status });
    }

    // Single batched INSERT, inside the mutex (P1).
    return this.deps.eventsStore.appendMany(userId, pending);
  }

  /** Fire the reminders of a place this step confirmed entering, unless it has notifyReminders off. */
  private async fireReminders(
    userId: UserId,
    places: readonly Place[],
    transitions: readonly DwellTransition[],
  ): Promise<Reminder[]> {
    const rules = rulesIn(places);
    const entered = transitions.find((t) => t.kind === "entered");
    if (!entered || !rules(entered.name).notifyReminders) return [];
    const reminders = await this.deps.remindersStore.listActiveForPlace(userId, entered.name);
    await this.deps.remindersStore.markTriggeredBatch(
      userId,
      reminders.map((r) => r.id),
    );
    return reminders;
  }

  /**
   * Time-based staleness check. If the current reading is stale and no
   * `presence.became_stale` has fired yet, emit one (once). Intended to be
   * called on read and/or by a periodic sweep. Serialized with ingest so the
   * stale flag does not race a concurrent upsert (F10/F13).
   */
  async checkStale(userId: UserId): Promise<PresenceEvent | null> {
    return this.mutex.run(userId, async () => {
      const current = await this.deps.presenceStore.getCurrent(userId);
      if (!current) return null;
      if (!isPastWindow(current, this.deps.config.privacy, this.clock) || current.staleEventFired) return null;
      await this.deps.presenceStore.setStaleEventFired(userId, true);
      return this.deps.eventsStore.append(userId, {
        type: "presence.became_stale",
        status: current.status,
        source: current.source,
      });
    });
  }

  /**
   * Periodic stale sweep across every user (system handle only): one query for
   * readings that have not fired `became_stale` yet, then `checkStale` per
   * user. One user's failure is logged and does not stop the others. Returns
   * the emitted events so the caller can nudge delivery.
   */
  async sweepStale(): Promise<PresenceEvent[]> {
    const candidates = await this.deps.presenceStore.listUnfiredStale();
    const due = candidates.filter((c) => isPastWindow(c, this.deps.config.privacy, this.clock));
    const results = await Promise.allSettled(due.map((c) => this.checkStale(c.userId)));
    const events: PresenceEvent[] = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        if (r.value) events.push(r.value);
      } else {
        log.error("stale sweep failed for a user", r.reason, { userId: due[i]!.userId });
      }
    });
    return events;
  }

  /**
   * Periodic dwell sweep across every user (system handle only): one query
   * for presence rows with an enter or a leave pending, then a dwell step at
   * now per user, under the user's lock, with no new reading. Returns the
   * emitted events so the caller can nudge delivery. Dwell resolves to the
   * sweep interval.
   */
  async sweepDwell(): Promise<PresenceEvent[]> {
    const users = await this.deps.presenceStore.listPendingDwell();
    const results = await Promise.allSettled(users.map((userId) => this.rejudge(userId)));
    const events: PresenceEvent[] = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        if (r.value) events.push(...r.value.events);
      } else {
        log.error("dwell sweep failed for a user", r.reason, { userId: users[i]! });
      }
    });
    return events;
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
  async reevaluateCurrent(userId: UserId): Promise<ProcessResult | null> {
    const result = await this.rejudge(userId);
    // A new or moved place can put the person at or near home: bring the area up to date too.
    if (result) this.deps.afterReading?.(userId);
    return result;
  }

  /**
   * A dwell step at now for the stored position against the current places,
   * under the user's lock: after a place change or on a sweep. Never checks
   * approach rings; drops deleted places from the approached set. Persists
   * the pending fields even when the status and the confirmed place stay.
   */
  private rejudge(userId: UserId): Promise<ProcessResult | null> {
    return this.mutex.run(userId, async () => {
      const prev = await this.deps.presenceStore.getCurrent(userId);
      if (!prev?.precise) return null;

      const places = await this.deps.placesStore.list(userId);
      const verdict = this.judge({ point: prev.precise, motion: prev.motion, places, dwell: dwellOf(prev), now: this.clock() });
      const names = new Set(places.map((p) => p.name));
      const next: StoredPresence = {
        ...prev,
        status: verdict.status,
        label: verdict.label,
        coarse: {
          ...prev.coarse,
          placeType: coarsePlaceTypeFor(verdict.confirmed),
        },
        ...dwellFields(verdict.dwell),
        approachedPlaces: (prev.approachedPlaces ?? []).filter((n) => names.has(n)),
        atOrNearHome: this.atOrNearHome(prev.precise, places),
      };

      if (next.status === prev.status && next.currentPlaceName === prev.currentPlaceName) {
        if (bookkeeping(next) !== bookkeeping(prev)) await this.deps.presenceStore.upsert(next);
        return { presence: toPresenceContext(next), events: [], triggeredReminders: [] };
      }

      await this.deps.presenceStore.upsert(next);
      const events = await this.emitEvents(userId, prev, next, places, verdict.transitions, []);
      const triggeredReminders = await this.fireReminders(userId, places, verdict.transitions);
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
    userId: UserId,
    patch: Partial<PrivacySettings>,
  ): Promise<{ settings: PrivacySettings; event: PresenceEvent | null }> {
    return this.mutex.run(userId, async () => {
      const before = await this.deps.settingsStore.getOrSeed(userId);
      const after = await this.deps.settingsStore.update(userId, patch);

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
        event = await this.deps.eventsStore.append(userId, {
          type: "presence.privacy_changed",
          status: current?.status,
        });
      }
      return { settings: after, event };
    });
  }
}
