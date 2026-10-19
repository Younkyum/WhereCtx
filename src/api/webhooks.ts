/**
 * Webhook subscription management API (plan section 9.7/9.8).
 *   GET    /v1/webhooks      -> list, with what this server can do (manage_privacy)
 *   POST   /v1/webhooks      -> create (manage_privacy)
 *   PATCH  /v1/webhooks/:id  -> change {events?, places?, active?, authHeader?} (manage_privacy)
 *   DELETE /v1/webhooks/:id  -> delete with its dead letters (manage_privacy)
 *
 * Delivery itself is handled by the dispatcher in Phase 4. A response never
 * carries a hook's credentials: no signing secret, and of the auth header only
 * its name and hint. An auth header is taken only when the server has
 * WEBHOOK_ENCRYPTION_KEY, since it is never stored in the clear.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { RouteContext } from "../app/context.js";
import type { WebhookListing } from "../store/webhooksStore.js";
import { PRESENCE_EVENT_TYPES } from "../types.js";
import { AUTH_HEADER_NAME_RULE, authHeaderNeedsHttps, authHeaderProblem, DEFAULT_AUTH_HEADER_NAME, viewAuthHeader, type AuthHeaderProblem } from "../webhooks/authHeader.js";
import { assertSafeWebhookUrl, SsrfError } from "../webhooks/ssrf.js";
import { parseBody } from "./accountHttp.js";
import { requireScope } from "./middleware.js";
import { parseLimit, zodMessages } from "./validation.js";
import type { AppEnv } from "./types.js";

const EVENT_TYPES = [...PRESENCE_EVENT_TYPES, "*"] as const;

/** Place names a hook's place events must name; null on PATCH clears the filter. */
const PlacesFilter = z.array(z.string().min(1).max(64)).min(1).max(50);

/** Per-user cap: each hook is drained on every dispatcher tick. */
const MAX_WEBHOOKS = 20;

const AUTH_HEADER_MESSAGES: Record<AuthHeaderProblem, string> = {
  name: "authHeader.name must be letters, digits and hyphens, at most 64 characters",
  notAllowed: `authHeader.name must be ${AUTH_HEADER_NAME_RULE}`,
  value: "authHeader.value must be 1 to 1024 printable ASCII characters, with no line breaks",
};

const AuthHeaderSchema = z
  .object({
    name: z.string().trim().default(DEFAULT_AUTH_HEADER_NAME),
    value: z.string().trim(),
  })
  .strict()
  .superRefine((h, ctx) => {
    const problem = authHeaderProblem(h.name, h.value);
    if (problem) ctx.addIssue({ code: "custom", message: AUTH_HEADER_MESSAGES[problem] });
  });

const NO_KEY = "set WEBHOOK_ENCRYPTION_KEY to use auth headers: they are only stored encrypted";
const NEEDS_HTTPS =
  "an auth header is sent only to an https URL; set WEBHOOK_ALLOW_PRIVATE_TARGETS=true to send one over http to a LAN receiver";

/** What a client sees of a hook: never a credential, and of an auth header only its name and hint. */
function publicWebhook(hook: WebhookListing) {
  const base = {
    id: hook.id,
    userId: hook.userId,
    url: hook.url,
    events: hook.events,
    ...(hook.places ? { places: hook.places } : {}),
    active: hook.active,
    cursor: hook.cursor,
    createdAt: hook.createdAt,
  };
  if ("credentialsUnreadable" in hook) return { ...base, credentialsUnreadable: true as const };
  return { ...base, ...(hook.authHeader ? { authHeader: viewAuthHeader(hook.authHeader) } : {}) };
}

const WebhookSchema = z.object({
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith("http://") || u.startsWith("https://"), {
      message: "url must be http(s)",
    }),
  events: z.array(z.enum(EVENT_TYPES)).optional(),
  places: PlacesFilter.optional(),
  secret: z.string().min(8).max(256).optional(),
  authHeader: AuthHeaderSchema.nullish(),
});

const PatchSchema = z
  .object({
    events: z.array(z.enum(EVENT_TYPES)).min(1).optional(),
    places: PlacesFilter.nullable().optional(),
    active: z.boolean().optional(),
    authHeader: AuthHeaderSchema.nullable().optional(),
  })
  .strict()
  .refine((p) => p.events !== undefined || p.places !== undefined || p.active !== undefined || p.authHeader !== undefined, {
    message: "nothing to change (events, places, active or authHeader)",
  });

export function webhooksRouter(ctx: RouteContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireScope("manage_privacy"));
  /** The store seals auth headers with the box built from this same key. */
  const sealsAuthHeaders = Boolean(ctx.config.webhooks.encryptionKey);
  const { allowPrivateTargets } = ctx.config.webhooks;
  const capabilities = { authHeader: sealsAuthHeaders, authHeaderRequiresHttps: !allowPrivateTargets };

  app.get("/", async (c) => {
    const hooks = await c.get("scope").webhooks.list();
    return c.json({ webhooks: hooks.map(publicWebhook), capabilities });
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
    if (parsed.data.authHeader && !sealsAuthHeaders) return c.json({ error: NO_KEY }, 400);
    if (parsed.data.authHeader && authHeaderNeedsHttps(parsed.data.url, allowPrivateTargets)) {
      return c.json({ error: NEEDS_HTTPS }, 400);
    }
    // SSRF guard: reject URLs that resolve to private/reserved addresses.
    try {
      await assertSafeWebhookUrl(parsed.data.url, allowPrivateTargets);
    } catch (e) {
      if (e instanceof SsrfError) return c.json({ error: e.message }, 400);
      throw e;
    }
    const scope = c.get("scope");
    if ((await scope.webhooks.count()) >= MAX_WEBHOOKS) {
      return c.json({ error: `webhook limit reached (${MAX_WEBHOOKS})` }, 409);
    }
    const created = await scope.webhooks.create({
      url: parsed.data.url,
      events: parsed.data.events ?? ["*"],
      places: parsed.data.places,
      secret: parsed.data.secret,
      authHeader: parsed.data.authHeader ?? undefined,
    });
    return c.json({ webhook: publicWebhook(created) }, 201);
  });

  // Dead-letter log: events permanently undeliverable after max attempts.
  app.get("/dead-letters", async (c) => {
    const limit = parseLimit(c.req.query("limit"), 100, 500);
    const deadLetters = await c.get("scope").webhooks.listDeadLetters(limit);
    return c.json({ deadLetters });
  });

  app.patch("/:id", async (c) => {
    const body = await parseBody(c, PatchSchema);
    if (body instanceof Response) return body;
    if (body.authHeader && !sealsAuthHeaders) return c.json({ error: NO_KEY }, 400);
    const scope = c.get("scope");
    const id = c.req.param("id");
    if (body.authHeader) {
      const hook = (await scope.webhooks.list()).find((h) => h.id === id);
      if (!hook) return c.json({ error: "webhook not found" }, 404);
      if (authHeaderNeedsHttps(hook.url, allowPrivateTargets)) return c.json({ error: NEEDS_HTTPS }, 400);
    }
    const updated = await scope.webhooks.update(id, body);
    if (!updated) return c.json({ error: "webhook not found" }, 404);
    return c.json({ webhook: publicWebhook(updated) });
  });

  app.delete("/:id", async (c) => {
    const deleted = await c.get("scope").webhooks.delete(c.req.param("id"));
    if (!deleted) return c.json({ error: "webhook not found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}
