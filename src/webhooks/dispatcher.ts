/**
 * Webhook dispatcher (plan section 9.8).
 *
 * Cursor-driven, at-least-once delivery. Each active webhook has a `cursor`
 * (ISO createdAt of the last delivered event); on each tick we read events
 * created after the cursor (in order), deliver those matching the hook's filter,
 * and advance the cursor on success. Because delivery is store-backed rather
 * than relying on the in-memory hand-off, events survive a sink outage or a
 * server restart and are retried (review finding P15).
 *
 * Deliveries are signed with HMAC-SHA256 over the body when the hook has a
 * secret. A permanently-failing endpoint is skipped after MAX_ATTEMPTS so it
 * cannot block its own queue forever (head-of-line guard).
 */

import { createHmac } from "node:crypto";
import type { EventsStore } from "../store/eventsStore.js";
import type { Webhook, WebhooksStore } from "../store/webhooksStore.js";
import type { PresenceEvent } from "../types.js";
import type { Clock } from "../util/time.js";
import { assertSafeWebhookUrl } from "./ssrf.js";

type FetchFn = typeof fetch;

export interface DispatcherOptions {
  webhooksStore: WebhooksStore;
  eventsStore: EventsStore;
  clock: Clock;
  fetchFn?: FetchFn;
  timeoutMs?: number;
  maxAttempts?: number;
  batchSize?: number;
  /** Allow delivery to private/reserved IPs (LAN targets). Default false. */
  allowPrivateTargets?: boolean;
  /** Override DNS resolution (tests). */
  urlResolver?: (host: string) => Promise<string[]>;
}

function eventPayload(ev: PresenceEvent): Record<string, unknown> {
  return {
    id: ev.id,
    event: ev.type,
    place: ev.placeName,
    status: ev.status,
    source: ev.source,
    timestamp: ev.createdAt,
  };
}

function subscribed(hook: Webhook, type: string): boolean {
  return hook.events.includes("*") || hook.events.includes(type);
}

export class WebhookDispatcher {
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly batchSize: number;
  private readonly allowPrivateTargets: boolean;
  private readonly attempts = new Map<string, number>();

  private running = false;
  private pending = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: DispatcherOptions) {
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.batchSize = opts.batchSize ?? 100;
    this.allowPrivateTargets = opts.allowPrivateTargets ?? false;
  }

  /** Schedule a tick soon (coalesced if one is already running). */
  nudge(): void {
    void this.tick();
  }

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.nudge(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    try {
      const hooks = await this.opts.webhooksStore.listActive();
      for (const hook of hooks) {
        await this.drainHook(hook);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("webhook dispatch tick error:", e);
    } finally {
      this.running = false;
      if (this.pending) {
        this.pending = false;
        void this.tick();
      }
    }
  }

  private async drainHook(hook: Webhook): Promise<void> {
    const events = await this.opts.eventsStore.listSince(hook.cursor ?? null, this.batchSize);
    for (const ev of events) {
      if (!subscribed(hook, ev.type)) {
        await this.opts.webhooksStore.setCursor(hook.id, ev.createdAt, ev.id);
        continue;
      }
      const key = `${hook.id}:${ev.id}`;
      const result = await this.deliver(hook, ev);
      if (result.ok) {
        this.attempts.delete(key);
        await this.opts.webhooksStore.setCursor(hook.id, ev.createdAt, ev.id);
        continue;
      }
      // Failed: count attempts; dead-letter + skip after maxAttempts (no HOL block).
      const n = (this.attempts.get(key) ?? 0) + 1;
      this.attempts.set(key, n);
      if (n >= this.maxAttempts) {
        // eslint-disable-next-line no-console
        console.warn(
          `webhook ${hook.id}: dead-lettering event ${ev.id} after ${n} attempts (${result.error})`,
        );
        await this.opts.webhooksStore.recordDeadLetter(hook.id, ev, result.error);
        this.attempts.delete(key);
        await this.opts.webhooksStore.setCursor(hook.id, ev.createdAt, ev.id);
        continue;
      }
      // Stop draining this hook; retry from here on the next tick.
      break;
    }
  }

  private async deliver(
    hook: Webhook,
    ev: PresenceEvent,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    // Re-validate the target at delivery time (DNS-rebinding/TOCTOU defense).
    try {
      await assertSafeWebhookUrl(hook.url, this.allowPrivateTargets, this.opts.urlResolver);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "unsafe url" };
    }

    const body = JSON.stringify(eventPayload(ev));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-wherectx-event": ev.type,
      "user-agent": "wherectx/0.1",
    };
    if (hook.secret) {
      const sig = createHmac("sha256", hook.secret).update(body).digest("hex");
      headers["x-wherectx-signature"] = `sha256=${sig}`;
    }
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(hook.url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
        redirect: "manual", // a 3xx must not bounce into an internal address
      });
      return res.ok ? { ok: true } : { ok: false, error: `status ${res.status}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "fetch failed" };
    } finally {
      clearTimeout(t);
    }
  }
}
