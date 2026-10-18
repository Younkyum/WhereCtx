/**
 * The signed-in person's own account (session only). Handlers act through the
 * request's AccountScope, already bound to this session.
 *   GET    /v1/me                          -> user, workspaces with role, passkeys, sessions
 *   PATCH  /v1/me                          -> change display name
 *   POST   /v1/me/reauth/options|verify    -> prove a passkey again (opens the step-up window)
 *   POST   /v1/me/passkeys/options|verify  -> register another passkey (step-up)
 *   DELETE /v1/me/passkeys/:id             -> remove a passkey, never the last (step-up)
 *   DELETE /v1/me/sessions/:id             -> sign out a session
 *   POST   /v1/me/sessions/revoke-others   -> sign out every other session
 *   POST   /v1/me/recovery-codes           -> replace recovery codes; shown once (step-up)
 */

import { Hono } from "hono";
import { z } from "zod";
import type { RouteContext } from "../app/context.js";
import type { SessionId } from "../accounts/types.js";
import {
  AuthenticationResponse,
  CeremonyState,
  DisplayName,
  PasskeyName,
  RegistrationResponse,
  parseBody,
  respond,
} from "./accountHttp.js";
import { clearSessionCookie } from "./session.js";
import type { SessionEnv } from "./types.js";

const Rename = z.object({ displayName: DisplayName });
const AddPasskey = z.object({
  ceremony: CeremonyState,
  response: RegistrationResponse,
  name: PasskeyName,
});
const Reauth = z.object({ ceremony: CeremonyState, response: AuthenticationResponse });

export function meRouter(ctx: RouteContext): Hono<SessionEnv> {
  const app = new Hono<SessionEnv>();

  app.get("/", async (c) => respond(c, await c.get("account").me.profile(), (p) => c.json(p)));

  app.patch("/", async (c) => {
    const body = await parseBody(c, Rename);
    if (body instanceof Response) return body;
    const result = await c.get("account").me.rename(body.displayName);
    return respond(c, result, (user) => c.json({ user }));
  });

  app.post("/reauth/options", async (c) => c.json(await c.get("account").me.reauthOptions()));

  app.post("/reauth/verify", async (c) => {
    const body = await parseBody(c, Reauth);
    if (body instanceof Response) return body;
    const result = await c.get("account").me.reauthVerify(body.ceremony, body.response);
    return respond(c, result, () => c.json({ ok: true }));
  });

  app.post("/passkeys/options", async (c) =>
    respond(c, await c.get("account").me.addPasskeyOptions(), (start) => c.json(start)),
  );

  app.post("/passkeys/verify", async (c) => {
    const body = await parseBody(c, AddPasskey);
    if (body instanceof Response) return body;
    const result = await c
      .get("account")
      .me.addPasskeyVerify(body.ceremony, body.response, body.name);
    return respond(c, result, (passkey) => c.json({ passkey }, 201));
  });

  app.delete("/passkeys/:id", async (c) => {
    const result = await c.get("account").me.deletePasskey(c.req.param("id"));
    return respond(c, result, () => c.json({ ok: true }));
  });

  app.delete("/sessions/:id", async (c) => {
    const account = c.get("account");
    const target = c.req.param("id") as SessionId;
    const result = await account.me.revokeSession(target);
    return respond(c, result, () => {
      if (target === account.sessionId) clearSessionCookie(c, ctx.config.baseUrl);
      return c.json({ ok: true });
    });
  });

  app.post("/sessions/revoke-others", async (c) =>
    c.json({ revoked: await c.get("account").me.revokeOtherSessions() }),
  );

  app.post("/recovery-codes", async (c) =>
    respond(c, await c.get("account").me.regenerateRecoveryCodes(), (recoveryCodes) =>
      c.json({ recoveryCodes }, 201),
    ),
  );

  return app;
}
