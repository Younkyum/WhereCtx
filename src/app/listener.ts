/**
 * The one Node request listener the server runs: /mcp goes to the MCP
 * transport, the OAuth protocol endpoints to oidc-provider, and everything
 * else to the Hono app. Each surface authenticates on its own, so a path that
 * falls through to Hono is fail-safe (a 404, never an auth bypass).
 */

import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { RateLimiter, nodeClientKey } from "../api/rateLimit.js";
import { mcpNodeHandler } from "../mcp/http.js";
import type { AppContext } from "./context.js";
import { buildApp, type BuildAppOptions } from "./server.js";

export type Surface = "mcp" | "oauth" | "app";

const OAUTH_DISCOVERY = new Set([
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
]);

/** Which surface serves a path. The consent API under /oauth/interaction/ is WhereCtx's own. */
export function surfaceFor(pathname: string): Surface {
  if (pathname === "/mcp") return "mcp";
  if (OAUTH_DISCOVERY.has(pathname)) return "oauth";
  if (pathname.startsWith("/oauth/") && !pathname.startsWith("/oauth/interaction/")) return "oauth";
  return "app";
}

/** OAuth endpoints anyone may call without a credential, each costing a database write or a fetch. */
const OAUTH_STARTERS = new Set(["/oauth/authorize", "/oauth/token", "/oauth/register"]);

export interface ListenerOptions extends BuildAppOptions {
  /** Shared by REST and MCP so auth failures on either count together. */
  authLimiter: RateLimiter;
  /** Requests per client to the OAuth starters. */
  oauthLimiter?: RateLimiter;
}

type Handler = (req: IncomingMessage, res: ServerResponse, pathname: string) => void;

export function createListener(ctx: AppContext, options: ListenerOptions): RequestListener {
  const mcp = mcpNodeHandler(ctx, options.authLimiter);
  const oauthLimiter = options.oauthLimiter ?? new RateLimiter({ windowMs: 60_000, max: 60 });
  const app = getRequestListener(buildApp(ctx, options).fetch);
  const handlers: Record<Surface, Handler> = {
    mcp: (req, res) => void mcp(req, res),
    oauth: (req, res, pathname) => {
      if (OAUTH_STARTERS.has(pathname)) {
        const key = nodeClientKey(req, ctx.config.trustProxy);
        if (oauthLimiter.isBlocked(key)) {
          res.writeHead(429, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "too many requests; retry later" }));
          return;
        }
        oauthLimiter.record(key);
      }
      ctx.oauth.handler(req, res);
    },
    app: (req, res) => void app(req, res),
  };
  return (req, res) => {
    // Match on the parsed pathname so query strings and encodings cannot
    // confuse the split.
    let pathname = req.url ?? "";
    try {
      pathname = new URL(req.url ?? "", "http://localhost").pathname;
    } catch {
      /* keep raw */
    }
    handlers[surfaceFor(pathname)](req, res, pathname);
  };
}
