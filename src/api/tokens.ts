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
import type { RouteContext } from "../app/context.js";
import { MAX_TOKENS } from "../auth/tokens.js";
import { mcpClientConfig } from "../devices/pairing.js";
import { noStore, requireFreshSession, requireScope } from "./middleware.js";
import { parseBody } from "./accountHttp.js";
import type { AppEnv } from "./types.js";

const CreateSchema = z.object({
  name: z.string().min(1).max(64),
  role: z.enum(["device", "agent", "admin"]),
});

/** The 409 for a mint refused by the per-user token cap. */
export function tokenLimitReached(c: Context): Response {
  return c.json({ error: `token limit reached (${MAX_TOKENS})` }, 409);
}

export function tokensRouter(ctx: RouteContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireScope("manage_tokens"));

  app.get("/", async (c) => {
    const tokens = await c.get("scope").tokens.list();
    return c.json({ tokens });
  });

  app.post("/", noStore, requireFreshSession(ctx), async (c) => {
    const body = await parseBody(c, CreateSchema);
    if (body instanceof Response) return body;
    const minted = await c.get("scope").tokens.create(body.name, body.role);
    if (minted === "limit") return tokenLimitReached(c);
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
