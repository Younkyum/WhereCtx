import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearLogs, log, recentLogs } from "./log.js";
import { Secret } from "./secret.js";

const VALUE = "ABCD-EFGH-JKLM";

describe("Secret", () => {
  let written: string[];
  beforeEach(() => {
    clearLogs();
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints as [secret] wherever it becomes text", () => {
    const secret = new Secret(VALUE);
    expect(`${secret}`).toBe("[secret]");
    expect(JSON.stringify({ secret })).toBe('{"secret":"[secret]"}');
    expect(inspect({ secret })).not.toContain(VALUE);
    expect(secret.reveal()).toBe(VALUE);
  });

  it("is revealed by banner on stdout, and masked if it slips into a field", () => {
    const secret = new Secret(VALUE);
    log.banner`code: ${secret}`;
    expect(written.join("")).toBe(`code: ${VALUE}\n`);
    (log.info as (msg: string, fields: object) => void)("oops", { secret, nested: { secret } });
    expect(JSON.stringify(recentLogs())).not.toContain(VALUE);
  });

  it("is refused by log.info, warn, error and debug at the type level", () => {
    const dir = mkdtempSync(join(tmpdir(), "secret-types-"));
    const logModule = new URL("./log.js", import.meta.url).pathname.replace(/\.js$/, ".ts");
    const secretModule = new URL("./secret.js", import.meta.url).pathname.replace(/\.js$/, ".ts");
    const file = join(dir, "probe.ts");
    writeFileSync(
      file,
      [
        `import { log } from ${JSON.stringify(logModule.replace(/\.ts$/, ".js"))};`,
        `import { Secret } from ${JSON.stringify(secretModule.replace(/\.ts$/, ".js"))};`,
        `const s = new Secret("x");`,
        `log.info(s);`,
        `log.warn("m", { code: s });`,
        `log.error("m", undefined, { code: s });`,
        `log.debug(s);`,
        `log.info("fine", { count: 1 });`,
        `log.banner\`ok \${s}\`;`,
      ].join("\n"),
    );
    try {
      const program = ts.createProgram([file], {
        strict: true,
        noEmit: true,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        target: ts.ScriptTarget.ES2022,
        types: ["node"],
        skipLibCheck: true,
      });
      const lines = ts
        .getPreEmitDiagnostics(program)
        .filter((d) => d.file?.fileName === file)
        .map((d) => d.file!.getLineAndCharacterOfPosition(d.start!).line + 1);
      expect([...new Set(lines)].sort()).toEqual([4, 5, 6, 7]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
