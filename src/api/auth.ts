/**
 * Passkey sign-in API (public: these routes create sessions rather than need one).
 *   POST /v1/auth/setup/options|verify        -> first owner, requires the boot setup code
 *   POST /v1/auth/login/options|verify        -> discoverable-credential sign-in
 *   POST /v1/auth/invite/preview              -> what an invite offers
 *   POST /v1/auth/invite/options|verify       -> sign up through an invite
 *   POST /v1/auth/recover                     -> sign in with a recovery code
 *   POST /v1/auth/access-code/options|verify  -> register a passkey with an operator access code
 *   POST /v1/auth/logout                      -> end the cookie's session
 *
 * Invite tokens and codes travel in JSON bodies, never in URL paths, so they
 * stay out of access logs. Every POST must come from this server's own origin
 * (same rule as session writes): a cross-site page must not be able to sign a
 * browser into an account the attacker controls. Credential failures answer
 * 401 so the auth-failure limiter counts them; the options endpoints and
 * /recover are also limited per client by request count, and /recover per
 * recovery-code lookup id.
 */

import { Hono, type Context } from "hono";
import { z } from "zod";
import type { RouteContext } from "../app/context.js";
import type { ClientInfo, PasskeyAuth, SignedIn } from "../accounts/authService.js";
import { parseRecoveryCode } from "../accounts/recoveryStore.js";
import {
  AuthenticationResponse,
  CeremonyState,
  DisplayName,
  InviteToken,
  PasskeyName,
  RegistrationResponse,
  parseBody,
  respond,
} from "./accountHttp.js";
import { RateLimiter, requestGuard } from "./rateLimit.js";
import {
  clearSessionCookie,
  readSessionCookie,
  sessionRequestAllowed,
  setSessionCookie,
} from "./session.js";

const Code = z.string().min(1).max(64);

const CodeOptions = z.object({ code: Code });
const CodeVerify = z.object({
  code: Code,
  ceremony: CeremonyState,
  response: RegistrationResponse,
  passkeyName: PasskeyName,
});
const LoginVerify = z.object({ ceremony: CeremonyState, response: AuthenticationResponse });
const InvitePreview = z.object({ token: InviteToken });
const InviteOptions = z.object({ token: InviteToken, displayName: DisplayName });
const InviteVerify = z.object({
  token: InviteToken,
  ceremony: CeremonyState,
  response: RegistrationResponse,
  passkeyName: PasskeyName,
});
const Recover = z.object({ code: Code });

export interface AuthRouterLimits {
  /** Requests per client to /{flow}/options and /recover. */
  requests: RateLimiter;
  /** Failed recoveries per recovery-code lookup id. */
  recoveryCodes: RateLimiter;
}

export function defaultAuthLimits(): AuthRouterLimits {
  return {
    requests: new RateLimiter({ windowMs: 60_000, max: 20 }),
    recoveryCodes: new RateLimiter({ windowMs: 15 * 60_000, max: 5 }),
  };
}

export function authRouter(
  ctx: RouteContext,
  auth: PasskeyAuth,
  limits: AuthRouterLimits = defaultAuthLimits(),
): Hono {
  const app = new Hono();
  const { baseUrl, trustProxy } = ctx.config;

  const client = (c: Context): ClientInfo => ({
    userAgent: c.req.header("user-agent"),
    priorSession: readSessionCookie(c, baseUrl),
  });
  const signIn = (c: Context, signedIn: SignedIn) => {
    setSessionCookie(c, signedIn.sessionSecret, baseUrl);
    return { userId: signedIn.userId };
  };

  app.use("*", async (c, next) => {
    if (!sessionRequestAllowed(c, baseUrl)) {
      return c.json({ error: "forbidden", detail: "cross-origin request refused" }, 403);
    }
    await next();
  });
  app.use("/:flow/options", requestGuard(limits.requests, trustProxy));
  app.use("/recover", requestGuard(limits.requests, trustProxy));

  app.post("/setup/options", async (c) => {
    const body = await parseBody(c, CodeOptions);
    if (body instanceof Response) return body;
    return respond(c, await auth.setupOptions(body.code), (start) => c.json(start));
  });

  app.post("/setup/verify", async (c) => {
    const body = await parseBody(c, CodeVerify);
    if (body instanceof Response) return body;
    const result = await auth.setupVerify(
      body.code,
      body.ceremony,
      body.response,
      body.passkeyName,
      client(c),
    );
    return respond(c, result, (enrolled) =>
      c.json({ ...signIn(c, enrolled), recoveryCodes: enrolled.recoveryCodes }, 201),
    );
  });

  app.post("/login/options", async (c) => c.json(await auth.loginOptions()));

  app.post("/login/verify", async (c) => {
    const body = await parseBody(c, LoginVerify);
    if (body instanceof Response) return body;
    const result = await auth.loginVerify(body.ceremony, body.response, client(c));
    return respond(c, result, (signedIn) => c.json(signIn(c, signedIn)));
  });

  app.post("/invite/preview", async (c) => {
    const body = await parseBody(c, InvitePreview);
    if (body instanceof Response) return body;
    return respond(c, await auth.previewInvite(body.token), (preview) => c.json(preview));
  });

  app.post("/invite/options", async (c) => {
    const body = await parseBody(c, InviteOptions);
    if (body instanceof Response) return body;
    const result = await auth.inviteOptions(body.token, body.displayName);
    return respond(c, result, (start) => c.json(start));
  });

  app.post("/invite/verify", async (c) => {
    const body = await parseBody(c, InviteVerify);
    if (body instanceof Response) return body;
    const result = await auth.inviteVerify(
      body.token,
      body.ceremony,
      body.response,
      body.passkeyName,
      client(c),
    );
    return respond(c, result, (joined) =>
      c.json(
        {
          ...signIn(c, joined),
          workspace: { ...joined.workspace, role: joined.role },
          recoveryCodes: joined.recoveryCodes,
        },
        201,
      ),
    );
  });

  app.post("/recover", async (c) => {
    const body = await parseBody(c, Recover);
    if (body instanceof Response) return body;
    const lookupId = parseRecoveryCode(body.code)?.lookupId;
    if (lookupId && limits.recoveryCodes.isBlocked(lookupId)) {
      return c.json({ error: "too many attempts for this recovery code; retry later" }, 429);
    }
    const result = await auth.recover(body.code, client(c));
    if (!result.ok && lookupId) limits.recoveryCodes.record(lookupId);
    // The account lost its passkeys (that is why recovery ran): the client
    // should register a new one now, while this session is fresh.
    return respond(c, result, (signedIn) =>
      c.json({ ...signIn(c, signedIn), registerPasskey: true }),
    );
  });

  app.post("/access-code/options", async (c) => {
    const body = await parseBody(c, CodeOptions);
    if (body instanceof Response) return body;
    return respond(c, await auth.accessCodeOptions(body.code), (start) => c.json(start));
  });

  app.post("/access-code/verify", async (c) => {
    const body = await parseBody(c, CodeVerify);
    if (body instanceof Response) return body;
    const result = await auth.accessCodeVerify(
      body.code,
      body.ceremony,
      body.response,
      body.passkeyName,
      client(c),
    );
    return respond(c, result, (enrolled) =>
      c.json({ ...signIn(c, enrolled), recoveryCodes: enrolled.recoveryCodes }, 201),
    );
  });

  app.post("/logout", async (c) => {
    const cookie = readSessionCookie(c, baseUrl);
    if (cookie) await auth.logout(cookie);
    clearSessionCookie(c, baseUrl);
    return c.json({ ok: true });
  });

  return app;
}
