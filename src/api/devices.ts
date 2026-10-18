/**
 * Device pairing (manage_tokens; a session must have re-proved its passkey,
 * since this mints a token exactly like POST /v1/tokens).
 *   POST /v1/devices/pair {name, kind: "owntracks"|"shortcut"}
 *     -> a new device token plus what the phone needs to use it:
 *        owntracks: the remote-config object, its owntracks:/// import link,
 *                   and that link as an SVG QR code
 *        shortcut:  the ingest URL, the token, and the headers to set
 *
 * The secret appears only in this response; the token counts toward the
 * per-user token cap.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { RouteContext } from "../app/context.js";
import { DEVICE_KINDS, ownTracksPairing, shortcutPairing } from "../devices/pairing.js";
import { parseBody } from "./accountHttp.js";
import { requireFreshSession, requireScope } from "./middleware.js";
import { mintToken } from "./tokens.js";
import type { AppEnv } from "./types.js";

const PairSchema = z.object({
  name: z.string().trim().min(1).max(64),
  kind: z.enum(DEVICE_KINDS),
});

export function devicesRouter(ctx: RouteContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireScope("manage_tokens"));

  app.post("/pair", requireFreshSession(ctx), async (c) => {
    const body = await parseBody(c, PairSchema);
    if (body instanceof Response) return body;
    const minted = await mintToken(c, c.get("scope"), body.name, "device");
    if (minted instanceof Response) return minted;
    const { token, secret } = minted;
    const { baseUrl } = ctx.config;
    const pairing =
      body.kind === "owntracks"
        ? await ownTracksPairing(baseUrl, body.name, secret)
        : shortcutPairing(baseUrl, secret);
    return c.json({ token, ...pairing }, 201);
  });

  return app;
}
