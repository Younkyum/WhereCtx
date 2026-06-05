// Live smoke: connect a real MCP client to the running /mcp endpoint and a
// webhook receiver, exercising the HTTP composition end-to-end.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer } from "node:http";

const BASE = process.env.BASE ?? "http://127.0.0.1:8802";
const ADMIN = process.env.ADMIN_TOKEN;
const DEVICE = process.env.DEVICE_TOKEN;
const AGENT = process.env.AGENT_TOKEN;

const j = (r) => r.json();
const auth = (t) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });

// 1. Webhook receiver
const received = [];
const sink = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ event: req.headers["x-wherectx-event"], sig: !!req.headers["x-wherectx-signature"], body });
    res.writeHead(200).end("ok");
  });
});
await new Promise((r) => sink.listen(8911, "127.0.0.1", r));

// 2. Register place + webhook
await fetch(`${BASE}/v1/places`, { method: "POST", headers: auth(ADMIN), body: JSON.stringify({ name: "home", lat: 37.0, lon: 127.0, radiusM: 150, type: "home" }) });
await fetch(`${BASE}/v1/webhooks`, { method: "POST", headers: auth(ADMIN), body: JSON.stringify({ url: "http://127.0.0.1:8911/hook", events: ["*"], secret: "smoke-secret-123" }) });

// 3. Device ingest at home -> triggers events -> webhook
await fetch(`${BASE}/v1/ingest`, { method: "POST", headers: auth(DEVICE), body: JSON.stringify({ lat: 37.0, lon: 127.0 }) });

// 4. MCP client over HTTP
const client = new Client({ name: "smoke", version: "0.0.0" }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
  requestInit: { headers: { authorization: `Bearer ${AGENT}` } },
});
await client.connect(transport);
const tools = (await client.listTools()).tools.map((t) => t.name).sort();
const presence = JSON.parse((await client.callTool({ name: "get_presence", arguments: {} })).content[0].text);
const near = JSON.parse((await client.callTool({ name: "is_near_place", arguments: { name: "home" } })).content[0].text);
const precise = await client.callTool({ name: "get_precise_location", arguments: { reason: "map" } });
await client.close();

// 5. Wait briefly for webhook delivery
await new Promise((r) => setTimeout(r, 1500));

console.log(JSON.stringify({
  mcpTools: tools,
  presence,
  near,
  preciseIsError: precise.isError ?? false,
  webhooksReceived: received.length,
  webhookEvents: received.map((r) => r.event),
  webhookSigned: received.every((r) => r.sig),
}, null, 2));

sink.close();
