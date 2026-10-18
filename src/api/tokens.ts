/**
 * Token management API (plan section 9.9 dashboard: view/regenerate tokens).
 *   GET    /v1/tokens      -> list tokens, no secrets (manage_tokens)
 *   POST   /v1/tokens      -> create; returns the plaintext secret ONCE (manage_tokens)
 *   DELETE /v1/tokens/:id  -> revoke (manage_tokens)
 */

import { Hono } from "hono";
import { z } from "zod";
import { requireScope } from "./middleware.js";
import { zodMessages } from "./validation.js";
import type { AppEnv } from "./types.js";

/** Per-user cap so one admin credential cannot mint tokens without bound. */
const MAX_TOKENS = 50;

const CreateSchema = z.object({
  name: z.string().min(1).max(64),
  role: z.enum(["device", "agent", "admin"]),
});

export function tokensRouter(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireScope("manage_tokens"));

  app.get("/", async (c) => {
    const tokens = await c.get("scope").tokens.list();
    return c.json({ tokens });
  });

  app.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "request body must be valid JSON" }, 400);
    }
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid token request", detail: zodMessages(parsed.error) }, 400);
    }
    const scope = c.get("scope");
    if ((await scope.tokens.count()) >= MAX_TOKENS) {
      return c.json({ error: `token limit reached (${MAX_TOKENS})` }, 409);
    }
    const { token, secret } = await scope.tokens.create(parsed.data.name, parsed.data.role);
    // The secret is shown exactly once.
    return c.json({ token, secret }, 201);
  });

  app.delete("/:id", async (c) => {
    const revoked = await c.get("scope").tokens.revoke(c.req.param("id"));
    if (!revoked) return c.json({ error: "token not found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}
