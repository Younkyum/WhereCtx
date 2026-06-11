/**
 * Webhook subscription management API (plan section 9.7/9.8).
 *   GET    /v1/webhooks      -> list (manage_privacy)
 *   POST   /v1/webhooks      -> create (manage_privacy)
 *   DELETE /v1/webhooks/:id  -> delete (manage_privacy)
 *
 * Delivery itself is handled by the dispatcher in Phase 4.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../app/context.js";
import { assertSafeWebhookUrl, SsrfError } from "../webhooks/ssrf.js";
import { bearerAuth, requireScope } from "./middleware.js";
import { parseLimit, zodMessages } from "./validation.js";
import type { AppEnv } from "./types.js";

const EVENT_TYPES = [
  "presence.updated",
  "presence.entered_place",
  "presence.left_place",
  "presence.became_stale",
  "presence.privacy_changed",
  "*",
] as const;

const WebhookSchema = z.object({
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith("http://") || u.startsWith("https://"), {
      message: "url must be http(s)",
    }),
  events: z.array(z.enum(EVENT_TYPES)).optional(),
  secret: z.string().min(8).max(256).optional(),
});

export function webhooksRouter(ctx: AppContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", bearerAuth(ctx));
  app.use("*", requireScope("manage_privacy"));

  app.get("/", async (c) => {
    const hooks = await ctx.webhooksStore.list();
    // Never echo secrets back.
    return c.json({ webhooks: hooks.map(({ secret: _s, ...rest }) => rest) });
  });

  app.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "request body must be valid JSON" }, 400);
    }
    const parsed = WebhookSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid webhook", detail: zodMessages(parsed.error) }, 400);
    }
    // SSRF guard: reject URLs that resolve to private/reserved addresses.
    try {
      await assertSafeWebhookUrl(
        parsed.data.url,
        ctx.config.webhooks.allowPrivateTargets,
      );
    } catch (e) {
      if (e instanceof SsrfError) return c.json({ error: e.message }, 400);
      throw e;
    }
    const created = await ctx.webhooksStore.create({
      url: parsed.data.url,
      events: parsed.data.events ?? ["*"],
      secret: parsed.data.secret,
    });
    const { secret: _s, ...rest } = created;
    return c.json({ webhook: rest }, 201);
  });

  // Dead-letter log: events permanently undeliverable after max attempts.
  app.get("/dead-letters", async (c) => {
    const limit = parseLimit(c.req.query("limit"), 100, 500);
    const deadLetters = await ctx.webhooksStore.listDeadLetters(limit);
    return c.json({ deadLetters });
  });

  app.delete("/:id", async (c) => {
    const deleted = await ctx.webhooksStore.delete(c.req.param("id"));
    if (!deleted) return c.json({ error: "webhook not found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}
