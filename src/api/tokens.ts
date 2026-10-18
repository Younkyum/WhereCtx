/**
 * Token management API (plan section 9.9 dashboard: view/regenerate tokens).
 *   GET    /v1/tokens      -> list tokens, no secrets (manage_tokens)
 *   POST   /v1/tokens      -> create; returns the plaintext secret ONCE (manage_tokens).
 *                             An agent token also comes with a ready MCP client config.
 *   DELETE /v1/tokens/:id  -> revoke (manage_tokens)
 *
 * A signed-in person minting a token of any role must have proved their
 * passkey within the step-up window: a token outlives the session and works
 * from anywhere, so creating one is as sensitive as adding a passkey.
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import type { RouteContext, UserScope } from "../app/context.js";
import { mcpClientConfig } from "../devices/pairing.js";
import type { Token, TokenRole } from "../types.js";
import { requireFreshSession, requireScope } from "./middleware.js";
import { parseBody } from "./accountHttp.js";
import type { AppEnv } from "./types.js";

/** Per-user cap so one admin credential cannot mint tokens without bound. */
const MAX_TOKENS = 50;

const CreateSchema = z.object({
  name: z.string().min(1).max(64),
  role: z.enum(["device", "agent", "admin"]),
});

/**
 * Mint a token within the per-user cap, or return the 409 to send. Every
 * route that hands out a credential (tokens, device pairing) goes through here.
 */
export async function mintToken(
  c: Context,
  scope: UserScope,
  name: string,
  role: TokenRole,
): Promise<{ token: Token; secret: string } | Response> {
  if ((await scope.tokens.count()) >= MAX_TOKENS) {
    return c.json({ error: `token limit reached (${MAX_TOKENS})` }, 409);
  }
  return scope.tokens.create(name, role);
}

export function tokensRouter(ctx: RouteContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireScope("manage_tokens"));

  app.get("/", async (c) => {
    const tokens = await c.get("scope").tokens.list();
    return c.json({ tokens });
  });

  app.post("/", requireFreshSession(ctx), async (c) => {
    const body = await parseBody(c, CreateSchema);
    if (body instanceof Response) return body;
    const minted = await mintToken(c, c.get("scope"), body.name, body.role);
    if (minted instanceof Response) return minted;
    const { token, secret } = minted;
    // The secret is shown exactly once.
    if (token.role !== "agent") return c.json({ token, secret }, 201);
    return c.json({ token, secret, mcpConfig: mcpClientConfig(ctx.config.baseUrl, secret) }, 201);
  });

  app.delete("/:id", async (c) => {
    const revoked = await c.get("scope").tokens.revoke(c.req.param("id"));
    if (!revoked) return c.json({ error: "token not found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}
