import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearLogs, recentLogs } from "../util/log.js";
import { testConfig } from "../testing/accounts.js";
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
