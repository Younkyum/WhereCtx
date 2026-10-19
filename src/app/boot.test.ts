import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearLogs, recentLogs } from "../util/log.js";
import { testConfig } from "../testing/accounts.js";
import { asUserId } from "../types.js";
import { startServer, type Running } from "./boot.js";

let stdout: string[];
let running: Running | undefined;

beforeEach(() => {
  clearLogs();
  stdout = [];
  const capture = (chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  };
  vi.spyOn(process.stdout, "write").mockImplementation(capture as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(capture as typeof process.stderr.write);
});

afterEach(async () => {
  await running?.close();
  running = undefined;
  vi.restoreAllMocks();
});

it("prints the setup code and the generated admin token to stdout only, never to the ring", async () => {
  running = await startServer(testConfig({ port: 0, bootstrapTokens: {} }));
  const out = stdout.join("");
  const setupCode = /^\s{4}([A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})$/m.exec(out)?.[1];
  const adminToken = /^\s{4}(wctx_\S+)$/m.exec(out)?.[1];
  expect(setupCode).toBeDefined();
  expect(adminToken).toBeDefined();
  expect((await running.ctx.system.tokens.verify(adminToken!))?.scopes).toContain("manage_tokens");

  const ring = JSON.stringify(recentLogs({ limit: 1000 }));
  expect(ring).toContain("WhereCtx listening");
  expect(ring).not.toContain(setupCode!);
  expect(ring).not.toContain(adminToken!);
  expect(ring).not.toContain(adminToken!.slice("wctx_".length, "wctx_".length + 12));

  const res = await fetch(`http://127.0.0.1:${running.port}/healthz`);
  expect(await res.json()).toEqual({ status: "ok" });
});

it("warns at boot about hooks whose auth header is stored unencrypted, which are not delivered", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const databaseUrl = `file:${join(await mkdtemp(join(tmpdir(), "wherectx-boot-")), "db.sqlite")}`;
  const webhooks = { allowPrivateTargets: false, encryptionKey: "boot-test-key" };
  running = await startServer(testConfig({ port: 0, databaseUrl, webhooks }));
  const hook = await running.ctx.system.webhooks.create(asUserId(running.ctx.config.defaultUserId), { url: "https://example.test/hook", events: ["*"] });
  await running.ctx.handle.client.execute({
    sql: "UPDATE webhooks SET auth_header = ? WHERE id = ?",
    args: [JSON.stringify({ name: "Authorization", value: "Bearer legacy-plaintext-credential" }), hook.id],
  });
  await running.close();
  clearLogs();

  running = await startServer(testConfig({ port: 0, databaseUrl, webhooks }));
  const warning = recentLogs({ limit: 1000 }).find((l) => JSON.stringify(l).includes("stored unencrypted"));
  expect(warning).toBeDefined();
  expect(JSON.stringify(warning)).toContain('"count":1');
  expect(JSON.stringify(recentLogs({ limit: 1000 }))).not.toContain("legacy-plaintext-credential");
  expect(await running.ctx.system.webhooks.listActive()).toEqual([]);
});
