/**
 * Webhook dispatcher (plan section 9.8).
 *
 * Cursor-driven, at-least-once delivery. Each active webhook has a `cursor`
 * (ISO createdAt of the last delivered event); a drain reads events created
 * after the cursor (in order), delivers those matching the hook's filter, and
 * advances the cursor on success. Because delivery is store-backed rather
 * than relying on the in-memory hand-off, events survive a sink outage or a
 * server restart and are retried (review finding P15).
 *
 * Hooks drain independently, so one slow endpoint cannot hold up another
 * user's delivery. A tick marks every active hook due; due hooks start in
 * least-recently-run order while there is a free slot (`maxConcurrent` in
 * all, `perUserSlots` per user), and a finishing drain hands its slot on. A
 * drain stops after `drainBudgetMs` and resumes from its cursor next tick.
 *
 * Deliveries are signed with HMAC-SHA256 over the body when the hook has a
 * secret, and carry the hook's auth header when it has one. The transport
 * connects only to addresses it has checked and never follows a redirect, so
 * neither reaches another URL. A permanently-failing endpoint is skipped after
 * MAX_ATTEMPTS so it cannot block its own queue forever (head-of-line guard).
 */

import { createHmac } from "node:crypto";
import type { EventsStore } from "../store/eventsStore.js";
import type { Webhook, WebhooksStore } from "../store/webhooksStore.js";
import type { PresenceEvent } from "../types.js";
import type { Clock } from "../util/time.js";
import { WEBHOOK_HEADERS, WEBHOOK_USER_AGENT, eventPayload } from "./payload.js";
import { assertSafeWebhookUrl, type Resolver } from "./ssrf.js";
import { connectTransport, type Transport } from "./transport.js";
import { log } from "../util/log.js";

export interface DispatcherOptions {
  webhooksStore: WebhooksStore;
  eventsStore: EventsStore;
  clock: Clock;
  /** Replaces the connecting transport (tests). */
  fetchFn?: Transport;
  timeoutMs?: number;
  maxAttempts?: number;
  batchSize?: number;
  /** Allow delivery to private/reserved IPs (LAN targets). Default false. */
  allowPrivateTargets?: boolean;
  /** Override DNS resolution (tests). */
  urlResolver?: Resolver;
  /** Drains running at once across all users. Default 8. */
  maxConcurrent?: number;
  /** Drains one user may run at once. Default 2. */
  perUserSlots?: number;
  /** A drain stops starting deliveries after this long. Default 10 s. */
  drainBudgetMs?: number;
}

function subscribed(hook: Webhook, type: string): boolean {
  return hook.events.includes("*") || hook.events.includes(type);
}

export class WebhookDispatcher {
  private readonly fetchFn: Transport;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly batchSize: number;
  private readonly allowPrivateTargets: boolean;
  private readonly maxConcurrent: number;
  private readonly perUserSlots: number;
  private readonly drainBudgetMs: number;
  private readonly attempts = new Map<string, number>();

  /** The slot table: one entry per running drain. */
  private readonly slots = new Map<string, { userId: string; done: Promise<void> }>();
  /** Hooks a tick asked for that have not started a drain since. */
  private readonly due = new Set<string>();
  /**
   * When each hook last started or finished a drain, on a counter. It orders
   * due hooks least-recently-run first, and lets a pump skip a hook whose
   * cursor moved after the pump read it.
   */
  private readonly touched = new Map<string, number>();
  private seq = 0;
  private readonly halt = new AbortController();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: DispatcherOptions) {
    this.allowPrivateTargets = opts.allowPrivateTargets ?? false;
    this.fetchFn = opts.fetchFn ?? connectTransport({ allowPrivate: this.allowPrivateTargets, resolver: opts.urlResolver });
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.batchSize = opts.batchSize ?? 100;
    this.maxConcurrent = opts.maxConcurrent ?? 8;
    this.perUserSlots = opts.perUserSlots ?? 2;
    this.drainBudgetMs = opts.drainBudgetMs ?? 10_000;
  }

  /** Deliver promptly: mark every hook due and start what fits. */
  nudge(): void {
    void this.tick();
  }

  start(intervalMs = 15_000): void {
    if (this.timer || this.halt.signal.aborted) return;
    this.timer = setInterval(() => this.nudge(), intervalMs);
    this.timer.unref?.();
  }

  /**
   * Stop ticking, abort in-flight deliveries, and resolve once every drain has
   * returned. An aborted delivery leaves its cursor in place, so it is retried
   * after a restart and does not count as a failed attempt.
   */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.halt.abort();
    await Promise.allSettled([...this.slots.values()].map((s) => s.done));
  }

  /** Mark every active hook due, start what fits, and wait for those drains. */
  async tick(): Promise<void> {
    await Promise.allSettled(await this.pump(true));
  }

  private async pump(markAllDue: boolean): Promise<Promise<void>[]> {
    if (this.halt.signal.aborted) return [];
    const readAt = this.seq;
    let hooks: Webhook[];
    try {
      hooks = await this.opts.webhooksStore.listActive();
    } catch (e) {
      log.error("webhook dispatch tick failed", e);
      return [];
    }
    if (this.halt.signal.aborted) return [];
    // Forget hooks that no longer exist or were deactivated so the maps
    // cannot accumulate orphaned entries (review P7).
    const activeIds = new Set(hooks.map((h) => h.id));
    for (const key of this.attempts.keys()) {
      if (!activeIds.has(key.slice(0, key.indexOf(":")))) this.attempts.delete(key);
    }
    for (const id of [...this.due, ...this.touched.keys()]) {
      if (!activeIds.has(id)) {
        this.due.delete(id);
        this.touched.delete(id);
      }
    }
    if (markAllDue) for (const id of activeIds) this.due.add(id);

    const started: Promise<void>[] = [];
    const order = hooks
      .filter((h) => this.due.has(h.id))
      .sort((a, b) => (this.touched.get(a.id) ?? -1) - (this.touched.get(b.id) ?? -1));
    for (const hook of order) {
      if (this.slots.size >= this.maxConcurrent) break;
      if (this.slots.has(hook.id)) continue;
      // Started or finished since we read it: our copy of the cursor is stale.
      if ((this.touched.get(hook.id) ?? -1) >= readAt) continue;
      if (this.slotsHeldBy(hook.userId) >= this.perUserSlots) continue;
      started.push(this.run(hook));
    }
    return started;
  }

  private slotsHeldBy(userId: string): number {
    let n = 0;
    for (const s of this.slots.values()) if (s.userId === userId) n++;
    return n;
  }

  private run(hook: Webhook): Promise<void> {
    this.due.delete(hook.id);
    this.touched.set(hook.id, this.seq++);
    const done = this.drainHook(hook)
      .catch((e) => {
        log.error("webhook drain failed", e, { webhookId: hook.id });
      })
      .finally(() => {
        this.slots.delete(hook.id);
        this.touched.set(hook.id, this.seq++);
        if (this.due.size > 0) void this.pump(false);
      });
    this.slots.set(hook.id, { userId: hook.userId, done });
    return done;
  }

  private async drainHook(hook: Webhook): Promise<void> {
    const startedAt = this.opts.clock().getTime();
    // Owner-scoped read: a hook only ever sees its own user's events.
    const events = await this.opts.eventsStore.listSince(
      hook.userId,
      hook.cursor ?? null,
      this.batchSize,
    );
    for (const ev of events) {
      if (this.halt.signal.aborted) return;
      // Out of budget: the persisted cursor is where the next tick resumes.
      if (this.opts.clock().getTime() - startedAt >= this.drainBudgetMs) return;
      // Each advance also checks the hook is still as this drain read it; when
      // it is not (paused, resumed, re-subscribed), stop and let the next tick
      // start from the stored hook.
      const advance = () => this.opts.webhooksStore.setCursor(hook, ev.createdAt, ev.id);
      if (!subscribed(hook, ev.type)) {
        if (!(await advance())) return;
        continue;
      }
      const key = `${hook.id}:${ev.id}`;
      const result = await this.deliver(hook, ev);
      if (result.ok) {
        this.attempts.delete(key);
        if (!(await advance())) return;
        continue;
      }
      if (this.halt.signal.aborted) return;
      // Failed: count attempts; dead-letter + skip after maxAttempts (no HOL block).
      const n = (this.attempts.get(key) ?? 0) + 1;
      this.attempts.set(key, n);
      if (n >= this.maxAttempts) {
        log.warn("webhook event dead-lettered", { webhookId: hook.id, eventId: ev.id, attempts: n, error: result.error });
        await this.opts.webhooksStore.recordDeadLetter(hook.id, ev, result.error);
        this.attempts.delete(key);
        if (!(await advance())) return;
        continue;
      }
      // Stop draining this hook; retry from here on the next tick.
      break;
    }
  }

  /**
   * A failed delivery's error is logged and kept as a dead letter, and a
   * fetch error can quote a header; the auth header's value never survives.
   */
  private async deliver(
    hook: Webhook,
    ev: PresenceEvent,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const result = await this.send(hook, ev);
    const value = hook.authHeader?.value;
    if (result.ok || !value) return result;
    return { ok: false, error: result.error.replaceAll(value, "[redacted]") };
  }

  private async send(
    hook: Webhook,
    ev: PresenceEvent,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    // Re-validate the target at delivery time. For a host name the transport
    // checks again at connect time; for an IP literal this is the check.
    try {
      await assertSafeWebhookUrl(hook.url, this.allowPrivateTargets, this.opts.urlResolver);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "unsafe url" };
    }

    const body = JSON.stringify(eventPayload(ev));
    // Headers, not an object literal: no name can land on a prototype and vanish.
    const headers = new Headers({
      "content-type": "application/json",
      [WEBHOOK_HEADERS.event]: ev.type,
      "user-agent": WEBHOOK_USER_AGENT,
    });
    if (hook.secret) {
      // BREAKING CHANGE (v0.2): The signed payload is `${timestamp}.${body}`, NOT
      // just `${body}` as it was in v0.1. Consumers MUST update their verification
      // logic to concatenate the `x-wherectx-timestamp` header value, a literal
      // dot, and the raw request body before computing the HMAC, otherwise all
      // signature checks will fail.
      //
      // Sign `${timestamp}.${body}` and expose the timestamp so consumers can
      // reject replayed deliveries (review M3; same shape as Stripe/GitHub).
      // Verify by recomputing HMAC-SHA256(secret, `${x-wherectx-timestamp}.${rawBody}`)
      // and rejecting when |now - timestamp| exceeds a small tolerance (e.g. 5 min).
      const ts = Math.floor(this.opts.clock().getTime() / 1000).toString();
      const sig = createHmac("sha256", hook.secret).update(`${ts}.${body}`).digest("hex");
      headers.set(WEBHOOK_HEADERS.timestamp, ts);
      headers.set(WEBHOOK_HEADERS.signature, `sha256=${sig}`);
    }
    if (hook.authHeader) headers.set(hook.authHeader.name, hook.authHeader.value);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(hook.url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.any([controller.signal, this.halt.signal]),
      });
      return res.ok ? { ok: true } : { ok: false, error: `status ${res.status}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "fetch failed" };
    } finally {
      clearTimeout(t);
    }
  }
}
