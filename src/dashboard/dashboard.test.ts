import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppContext } from "../app/context.js";
import { buildApp } from "../app/server.js";
import { testConfig } from "../testing/accounts.js";
import { loadDashboardFiles } from "./router.js";

const WEB = fileURLToPath(new URL("../../web/", import.meta.url));

let dir: string;
let app: Hono;
let index: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "wherectx-dashboard-"));
  await build({ configFile: join(WEB, "vite.config.ts"), logLevel: "silent", build: { outDir: dir } });
  index = readFileSync(join(dir, "index.html"), "utf8");
  const booted = await createAppContext(testConfig());
  app = buildApp(booted.ctx, { dashboardDir: dir });
}, 120_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const assetRefs = (html: string) => [...html.matchAll(/(?:src|href)="\/dashboard\/([^"]+)"/g)].map((m) => m[1]!);

describe("dashboard router (serving a real build)", () => {
  it("serves the page at /dashboard and /dashboard/ (the invite link form), revalidated on each load", async () => {
    for (const path of ["/dashboard", "/dashboard/"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(res.headers.get("etag")).toBeTruthy();
      expect(await res.text()).toBe(index);
    }
  });

  it("serves hashed assets with their content type and a long immutable cache", async () => {
    const refs = assetRefs(index);
    expect(refs.some((r) => r.endsWith(".js"))).toBe(true);
    expect(refs.some((r) => r.endsWith(".css"))).toBe(true);
    for (const ref of refs) {
      const res = await app.request(`/dashboard/${ref}`);
      expect(res.status, ref).toBe(200);
      expect(res.headers.get("content-type"), ref).toBe(ref.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8");
      expect(res.headers.get("cache-control"), ref).toBe("public, max-age=31536000, immutable");
      expect(Buffer.from(await res.arrayBuffer()).equals(readFileSync(join(dir, ref))), ref).toBe(true);
    }
    const font = readdirSync(join(dir, "assets")).find((f) => f.endsWith(".woff2"))!;
    expect((await app.request(`/dashboard/assets/${font}`)).headers.get("content-type")).toBe("font/woff2");
  });

  it("answers 404 for anything outside the build, however the path is spelled", async () => {
    for (const path of [
      "/dashboard/nope.js",
      "/dashboard/assets/nope.js",
      "/dashboard/__proto__",
      "/dashboard/constructor",
      "/dashboard/../package.json",
      "/dashboard/%2e%2e/package.json",
      "/dashboard/assets/..%2f..%2fpackage.json",
      "/dashboard/..%5c..%5cpackage.json",
      "/dashboard//etc/passwd",
      "/dashboard/.vite/manifest.json",
    ]) {
      expect((await app.request(path)).status, path).toBe(404);
    }
  });

  it("serves only the build's own files, and nothing hidden or of an unknown type", () => {
    const fixture = mkdtempSync(join(tmpdir(), "wherectx-dashboard-fixture-"));
    mkdirSync(join(fixture, "assets"));
    mkdirSync(join(fixture, ".vite"));
    writeFileSync(join(fixture, "index.html"), "<!doctype html>");
    writeFileSync(join(fixture, "assets", "app-abc123.js"), "export {}");
    writeFileSync(join(fixture, ".vite", "manifest.json"), "{}");
    writeFileSync(join(fixture, "notes.txt"), "secret");
    writeFileSync(join(fixture, ".env"), "TOKEN=x");
    try {
      expect([...loadDashboardFiles(fixture).keys()].sort()).toEqual(["assets/app-abc123.js", "index.html"]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("says the dashboard is not built instead of failing when the build is missing", async () => {
    const booted = await createAppContext(testConfig());
    const bare = buildApp(booted.ctx, { dashboardDir: join(dir, "missing") });
    expect((await bare.request("/dashboard/")).status).toBe(503);
    expect((await bare.request("/dashboard/assets/x.js")).status).toBe(404);
  });

  it("keeps the CSP: scripts and images only from this origin", async () => {
    const res = await app.request("/dashboard/");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/script-src 'self';/);
    expect(csp).toMatch(/img-src 'self';/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("the built page", () => {
  it("has no inline script, no inline handler, and loads one module script from /dashboard/assets/", () => {
    const scripts = [...index.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]![1]).toMatch(/type="module"[^>]*src="\/dashboard\/assets\/index-[\w-]+\.js"/);
    expect(scripts[0]![2]).toBe("");
    expect(index).not.toMatch(/\son[a-z]+\s*=/i);
    expect(index).not.toMatch(/<style\b/i);
  });

  it("references only files that exist in the build, including fonts from the stylesheet", () => {
    const refs = assetRefs(index);
    const css = refs.filter((r) => r.endsWith(".css")).map((r) => readFileSync(join(dir, r), "utf8")).join("\n");
    const cssRefs = [...css.matchAll(/url\(\/dashboard\/([^)]+)\)/g)].map((m) => m[1]!);
    expect(cssRefs.length).toBeGreaterThan(0);
    for (const ref of [...refs, ...cssRefs]) expect(statSync(join(dir, ref)).isFile(), ref).toBe(true);
  });

  it("inlines nothing as a data: URI and loads nothing from another origin", () => {
    for (const file of readdirSync(join(dir, "assets"))) {
      if (!/\.(js|css)$/.test(file)) continue;
      const body = readFileSync(join(dir, "assets", file), "utf8");
      expect(body, file).not.toMatch(/url\(\s*["']?data:/i);
      expect(body, file).not.toMatch(/@import\s+url\(\s*["']?https?:/i);
      expect(body, file).not.toContain("fonts.googleapis.com");
    }
  });
});

const webSource = () => {
  const root = join(WEB, "src");
  return (readdirSync(root, { recursive: true, encoding: "utf8" }) as string[])
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => [f, readFileSync(join(root, f), "utf8")] as const);
};

describe("web source lints", () => {
  it("never inserts markup: no dangerouslySetInnerHTML, innerHTML or insertAdjacentHTML", () => {
    for (const [file, body] of webSource()) {
      expect(body, file).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\b|outerHTML|insertAdjacentHTML|document\.write/);
    }
  });

  it("keeps the session in the cookie: no tokens in storage, no Authorization header", () => {
    for (const [file, body] of webSource()) {
      expect(body, file).not.toMatch(/wherectx_admin_token|sessionStorage/);
      expect(body, file).not.toMatch(/["']authorization["']\s*:/i);
    }
  });
});
