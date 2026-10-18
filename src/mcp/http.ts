/**
 * Raw-Node HTTP handler for the MCP endpoint (mounted at /mcp).
 *
 * Runs outside Hono (composed at the http.Server level via getRequestListener)
 * because the MCP StreamableHTTP transport writes directly to the Node response.
 * Each request is authenticated (a WhereCtx token or an OAuth access token,
 * with read_presence scope) and gets a fresh, stateless server+transport so
 * there is no cross-request session state. Refusals carry the RFC 6750 /
 * RFC 9728 challenge that tells an MCP client where to get a token.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AppContext } from "../app/context.js";
import { nodeClientKey, type RateLimiter } from "../api/rateLimit.js";
import { resolveBearerPrincipal } from "../auth/principal.js";
import { RESOURCE_SCOPES, oauthScopeFor } from "../oauth/scopes.js";
import { buildMcpServer } from "./server.js";

// Match the REST body cap (app/server.ts bodyLimit) for consistency.
const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(text);
}

const REQUIRED_SCOPE = oauthScopeFor("read_presence")!;

/** Why /mcp refused a request, each with its status and Bearer challenge parameters. */
const REFUSALS = {
  missing: { status: 401, body: { error: "unauthorized" }, params: { scope: RESOURCE_SCOPES.join(" ") } },
  invalid: {
    status: 401,
    body: { error: "unauthorized" },
    params: { error: "invalid_token", scope: RESOURCE_SCOPES.join(" ") },
  },
  scope: {
    status: 403,
    body: { error: "forbidden", detail: "requires read_presence scope" },
    params: { error: "insufficient_scope", scope: REQUIRED_SCOPE },
  },
} as const;

function refuse(res: ServerResponse, why: keyof typeof REFUSALS, resourceMetadata: string): void {
  const { status, body, params } = REFUSALS[why];
  const challenge = Object.entries({ ...params, resource_metadata: resourceMetadata })
    .map(([k, v]) => `${k}="${v}"`)
    .join(", ");
  sendJson(res, status, body, { "www-authenticate": `Bearer ${challenge}` });
}

function bearerSecret(req: IncomingMessage): string | null {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : null;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (over) return; // stop buffering; the response (413) is sent by the caller
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        over = true;
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (over) return;
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", (e) => {
      if (!over) reject(e);
    });
  });
}

/** Returns a Node request listener for the MCP endpoint; it never rejects. */
export function mcpNodeHandler(ctx: AppContext, authLimiter?: RateLimiter) {
  const handle = mcpRequest(ctx, authLimiter);
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      await handle(req, res);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("mcp request error:", e);
      if (!res.headersSent) sendJson(res, 500, { error: "internal server error" });
      else res.end();
    }
  };
}

function mcpRequest(ctx: AppContext, authLimiter?: RateLimiter) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Same failed-auth throttle as the REST surface (shared limiter, review M1).
    const clientKey = authLimiter ? nodeClientKey(req, ctx.config.trustProxy) : "";
    if (authLimiter?.isBlocked(clientKey)) {
      return sendJson(res, 429, {
        error: "too many failed authentication attempts; retry later",
      });
    }

    const { resourceMetadata } = ctx.oauth.urls;
    const secret = bearerSecret(req);
    const principal = await resolveBearerPrincipal(ctx, secret);
    if (!principal) {
      // A credential-less request is a client discovering where to get a
      // token, not a guess, so only a rejected credential counts.
      if (!secret) return refuse(res, "missing", resourceMetadata);
      authLimiter?.record(clientKey);
      return refuse(res, "invalid", resourceMetadata);
    }
    if (!principal.scopes.includes("read_presence")) return refuse(res, "scope", resourceMetadata);

    let body: unknown;
    if (req.method === "POST") {
      try {
        body = await readJsonBody(req);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "bad request";
        return sendJson(res, msg === "payload too large" ? 413 : 400, { error: msg });
      }
    }

    const server = buildMcpServer(ctx.forUser(principal.userId), principal, ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}
