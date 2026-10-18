/**
 * Device pairing (manage_tokens; a session must have re-proved its passkey,
 * since this mints a token exactly like POST /v1/tokens).
 *   POST /v1/devices/pair {name, kind: "owntracks"|"shortcut"}
 *     -> a new device token plus what the phone needs to use it:
 *        owntracks: the remote-config object, its owntracks:/// import link,
 *                   and that link as an SVG QR code
 *        shortcut:  the ingest URL, the token, and the headers to set
 *
 * The secret appears only in this response (never cached); the token counts
 * toward the per-user token cap. A BASE_URL a phone cannot use (loopback, or
 * not https) is refused before anything is minted: 400 base_url_unusable.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { RouteContext } from "../app/context.js";
import {
  DEVICE_KINDS,
  ownTracksPairing,
  pairingBaseUrlProblem,
  shortcutPairing,
} from "../devices/pairing.js";
import { parseBody } from "./accountHttp.js";
import { noStore, requireFreshSession, requireScope } from "./middleware.js";
import { tokenLimitReached } from "./tokens.js";
import type { AppEnv } from "./types.js";

const PairSchema = z.object({
  name: z.string().trim().min(1).max(64),
  kind: z.enum(DEVICE_KINDS),
});

export function devicesRouter(ctx: RouteContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireScope("manage_tokens"));

  app.post("/pair", noStore, requireFreshSession(ctx), async (c) => {
    const body = await parseBody(c, PairSchema);
    if (body instanceof Response) return body;
    const { baseUrl } = ctx.config;
    const problem = pairingBaseUrlProblem(baseUrl);
    if (problem) return c.json({ error: problem, code: "base_url_unusable" }, 400);
    const minted = await c.get("scope").tokens.create(body.name, "device");
    if (minted === "limit") return tokenLimitReached(c);
    const { token, secret } = minted;
    const pairing =
      body.kind === "owntracks"
        ? await ownTracksPairing(baseUrl, body.name, secret)
        : shortcutPairing(baseUrl, secret);
    return c.json({ token, ...pairing }, 201);
  });

  return app;
}
