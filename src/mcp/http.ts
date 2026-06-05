/**
 * Raw-Node HTTP handler for the MCP endpoint (mounted at /mcp).
 *
 * Runs outside Hono (composed at the http.Server level via getRequestListener)
 * because the MCP StreamableHTTP transport writes directly to the Node response.
 * Each request is authenticated (Bearer token with read_presence scope) and gets
 * a fresh, stateless server+transport so there is no cross-request session state.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AppContext } from "../app/context.js";
import { buildMcpServer } from "./server.js";

// Match the REST body cap (app/server.ts bodyLimit) for consistency.
const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
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

/** Returns a Node request listener for the MCP endpoint. */
export function mcpNodeHandler(ctx: AppContext) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Authenticate: agent/admin tokens with read_presence.
    const token = await ctx.tokens.verify(bearerSecret(req));
    if (!token) return sendJson(res, 401, { error: "unauthorized" });
    if (!token.scopes.includes("read_presence")) {
      return sendJson(res, 403, { error: "forbidden", detail: "requires read_presence scope" });
    }

    let body: unknown;
    if (req.method === "POST") {
      try {
        body = await readJsonBody(req);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "bad request";
        return sendJson(res, msg === "payload too large" ? 413 : 400, { error: msg });
      }
    }

    const server = buildMcpServer(ctx, token);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("mcp request error:", e);
      if (!res.headersSent) sendJson(res, 500, { error: "internal server error" });
    }
  };
}
