// End-to-end over HTTP: the built server (dist/) with the fake maps provider,
// an agent asking for routes by car, transit, on foot and by bicycle over REST
// and MCP, and what reaches it and the access log. Run `npm run build` first.
//
// The switches that send more out need a passkey in the dashboard, which a
// script cannot give, so they are turned on in the database directly.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = Number(process.env.PORT ?? 8813);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = "e2e-admin-token-0123456789abcdefghij";
const AGENT = "e2e-agent-token-0123456789abcdefghij";
const DEVICE = "e2e-device-token-0123456789abcdefghi";
const dir = mkdtempSync(join(tmpdir(), "wherectx-geo-e2e-"));
const DB = `file:${join(dir, "e2e.db")}`;

const server = spawn(process.execPath, ["dist/index.js"], {
  env: {
    PATH: process.env.PATH,
    NODE_ENV: "development",
    PORT: String(PORT),
    HOST: "127.0.0.1",
    BASE_URL: BASE,
    DATABASE_URL: DB,
    ADMIN_TOKEN: ADMIN,
    AGENT_TOKEN: AGENT,
    DEVICE_TOKEN: DEVICE,
    GEO_PROVIDER_FAKE: "1",
    KAKAO_REST_API_KEY: "e2e-fake-kakao-key",
    NAVER_MAPS_CLIENT_ID: "e2e-fake-naver-id",
    NAVER_MAPS_CLIENT_SECRET: "e2e-fake-naver-secret",
  },
  stdio: ["ignore", "ignore", "inherit"],
});

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
}

const headers = (token) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
const get = async (token, path) => {
  const res = await fetch(`${BASE}${path}`, { headers: headers(token) });
  return { status: res.status, text: await res.text() };
};
const post = (token, path, body) => fetch(`${BASE}${path}`, { method: "POST", headers: headers(token), body: JSON.stringify(body) });

const STOP_WORDS = ["정류장", "테스트환승역", "테스트중간역", "테스트도착역", "마을 테스트1", "간선 472"];
const STREETS = ["테스트출발로", "테스트도착로"];
const AWAY = { lat: 37.5665432, lon: 126.9784321 };

try {
  for (let i = 0; ; i++) {
    if ((await fetch(`${BASE}/healthz`).catch(() => null))?.ok) break;
    if (i > 100) throw new Error("the server did not start");
    await new Promise((r) => setTimeout(r, 100));
  }

  await post(ADMIN, "/v1/places", { name: "home", type: "home", lat: 37.45, lon: 127.3, radiusM: 150 });
  await post(ADMIN, "/v1/places", { name: "office", type: "work", lat: 37.4, lon: 127.1, radiusM: 150 });
  await post(DEVICE, "/v1/ingest", { source: "manual", ...AWAY });
  await get(ADMIN, "/v1/privacy");
  const db = createClient({ url: DB });
  await db.execute("UPDATE privacy_settings SET geo_enabled = 1, eta_to_agents = 1");

  const transit = await get(AGENT, "/v1/geo/eta?to=office&mode=transit");
  const t = JSON.parse(transit.text).eta;
  console.log(`REST transit ${transit.status}: ${JSON.stringify(t)}`);
  check(transit.status === 200 && t.mode === "transit" && JSON.stringify(t.summary) === '["2호선"]', "transit names only the line clear of both ends");
  check(t.transfers === 2 && t.walkMin % 5 === 0 && t.durationMin % 5 === 0, "transfers, and minutes in 5-minute steps");
  check(STOP_WORDS.every((w) => !transit.text.includes(w)), "no stop name, no line near either end");
  check(["fare", "legs", "path", "steps"].every((k) => !(k in t)), "no fare, legs, path or steps");
  check(!/37\.56|126\.97|37\.4\b|127\.1\b/.test(transit.text), "no coordinate");

  for (const mode of ["walk", "bike"]) {
    const res = await get(AGENT, `/v1/geo/eta?to=office&mode=${mode}&directions=true`);
    const body = JSON.parse(res.text).eta;
    console.log(`REST ${mode} ${res.status}: ${JSON.stringify(body)}`);
    check(res.status === 200 && body.mode === mode && body.summary.length === 0 && typeof body.stepsWithheld === "string", `${mode} answers with no street and withholds the steps`);
    check(STREETS.every((w) => !res.text.includes(w)), `${mode} names no street`);
  }
  check((await get(AGENT, "/v1/geo/eta?to=office&mode=boat")).status === 400, "an unknown mode is a 400");

  const mcp = new Client({ name: "e2e", version: "0.0.0" }, { capabilities: {} });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${AGENT}` } } }));
  const tool = await mcp.callTool({ name: "get_directions", arguments: { to: "office", mode: "transit" } });
  const toolText = tool.content[0].text;
  console.log(`MCP get_directions transit: ${toolText}`);
  check(!tool.isError && JSON.parse(toolText).stepsWithheld && STOP_WORDS.every((w) => !toolText.includes(w)), "MCP transit withholds the steps and names no stop");
  const description = (await mcp.listTools()).tools.find((x) => x.name === "get_eta").description;
  check(/transit/.test(description) && /approximate/.test(description), "get_eta says it takes transit and answers approximately");
  await mcp.close();

  const actions = (await db.execute("SELECT action FROM access_log")).rows.map((r) => r.action);
  console.log(`access log route actions: ${[...new Set(actions.filter((a) => String(a).startsWith("geo.route")))].sort().join(", ")}`);
  check(["geo.route.transit", "geo.route.walk", "geo.route.bike"].every((a) => actions.includes(a)), "each provider call is logged under its mode");

  await db.execute("UPDATE privacy_settings SET geo_provider = 'naver'");
  const naver = await get(AGENT, "/v1/geo/eta?to=office&mode=transit");
  console.log(`REST transit on Naver ${naver.status}: ${naver.text}`);
  check(naver.status === 409 && JSON.parse(naver.text).unsupported === "mode", "Naver answers unsupported_mode");
  check((await get(AGENT, "/v1/geo/eta?to=office")).status === 200, "Naver still routes a car");
  db.close();
} catch (e) {
  console.error(e);
  failures++;
} finally {
  server.kill();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
