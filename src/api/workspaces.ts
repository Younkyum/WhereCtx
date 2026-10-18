/**
 * Workspaces API (session only; tokens hold no workspace rights).
 *   GET    /v1/workspaces                          -> workspaces I belong to, with my role
 *   POST   /v1/workspaces                          -> create; I become its owner
 *   POST   /v1/workspaces/invites/accept           -> join another workspace by invite ({token})
 *   PATCH  /v1/workspaces/:id                      -> rename
 *   GET    /v1/workspaces/:id/members              -> members and roles
 *   PATCH  /v1/workspaces/:id/members/:userId      -> change a member's role
 *   DELETE /v1/workspaces/:id/members/:userId      -> remove a member, or leave (my own id)
 *   POST   /v1/workspaces/:id/invites              -> invite link; the token is shown once
 *   GET    /v1/workspaces/:id/invites              -> pending invites
 *   DELETE /v1/workspaces/:id/invites/:inviteId    -> revoke an invite
 *
 * Every rule (who may do what, the last-owner guard, 404 for non-members) is
 * decided behind the request's AccountScope; this router only parses and renders.
 */

import { Hono } from "hono";
import { z } from "zod";
import { asWorkspaceId } from "../accounts/types.js";
import { asUserId } from "../types.js";
import { DisplayName, InviteToken, Role, parseBody, respond } from "./accountHttp.js";
import type { SessionEnv } from "./types.js";

const Named = z.object({ name: DisplayName });
const ChangeRole = z.object({ role: Role });
const CreateInvite = z.object({ role: Role });
const AcceptInvite = z.object({ token: InviteToken });

export function workspacesRouter(): Hono<SessionEnv> {
  const app = new Hono<SessionEnv>();

  app.get("/", async (c) => c.json({ workspaces: await c.get("account").workspaces.list() }));

  app.post("/", async (c) => {
    const body = await parseBody(c, Named);
    if (body instanceof Response) return body;
    const result = await c.get("account").workspaces.create(body.name);
    return respond(c, result, (workspace) => c.json({ workspace }, 201));
  });

  app.post("/invites/accept", async (c) => {
    const body = await parseBody(c, AcceptInvite);
    if (body instanceof Response) return body;
    const result = await c.get("account").workspaces.acceptInvite(body.token);
    return respond(c, result, (workspace) => c.json({ workspace }));
  });

  app.patch("/:id", async (c) => {
    const body = await parseBody(c, Named);
    if (body instanceof Response) return body;
    const result = await c
      .get("account")
      .workspaces.rename(asWorkspaceId(c.req.param("id")), body.name);
    return respond(c, result, (workspace) => c.json({ workspace }));
  });

  app.get("/:id/members", async (c) => {
    const result = await c.get("account").workspaces.listMembers(asWorkspaceId(c.req.param("id")));
    return respond(c, result, (members) => c.json({ members }));
  });

  app.patch("/:id/members/:userId", async (c) => {
    const body = await parseBody(c, ChangeRole);
    if (body instanceof Response) return body;
    const result = await c
      .get("account")
      .workspaces.changeRole(
        asWorkspaceId(c.req.param("id")),
        asUserId(c.req.param("userId")),
        body.role,
      );
    return respond(c, result, () => c.json({ ok: true }));
  });

  app.delete("/:id/members/:userId", async (c) => {
    const result = await c
      .get("account")
      .workspaces.removeMember(asWorkspaceId(c.req.param("id")), asUserId(c.req.param("userId")));
    return respond(c, result, () => c.json({ ok: true }));
  });

  app.post("/:id/invites", async (c) => {
    const body = await parseBody(c, CreateInvite);
    if (body instanceof Response) return body;
    const result = await c
      .get("account")
      .workspaces.createInvite(asWorkspaceId(c.req.param("id")), body.role);
    // The url embeds the invite token, which is not shown again.
    return respond(c, result, ({ invite, url }) =>
      c.json({ invite, url, expiresAt: invite.expiresAt }, 201),
    );
  });

  app.get("/:id/invites", async (c) => {
    const result = await c.get("account").workspaces.listInvites(asWorkspaceId(c.req.param("id")));
    return respond(c, result, (invites) => c.json({ invites }));
  });

  app.delete("/:id/invites/:inviteId", async (c) => {
    const result = await c
      .get("account")
      .workspaces.revokeInvite(asWorkspaceId(c.req.param("id")), c.req.param("inviteId"));
    return respond(c, result, () => c.json({ ok: true }));
  });

  return app;
}
