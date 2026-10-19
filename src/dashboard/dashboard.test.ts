import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppContext } from "../app/context.js";
import { buildApp } from "../app/server.js";
import { TestClock, bootApp, setupOwner, signUpByInvite, testConfig, type Enrolled } from "../testing/accounts.js";
import { MAP_FRAME_PATH, STRICT_POLICY } from "../app/securityHeaders.js";
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

describe("one strict page for everyone, and one map frame that allows the providers", () => {
  const STRICT =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
  let mapped: Hono;
  let owner: Enrolled;

  const directive = (csp: string, name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `));

  beforeAll(async () => {
    const booted = await bootApp(new TestClock(), {}, { dashboardDir: dir });
    mapped = booted.app;
    owner = await setupOwner(mapped, booted.setupCode);
    await owner.browser.json("/v1/privacy", { method: "PUT", body: { geoEnabled: true, geoProvider: null } });
    await owner.browser.json("/v1/geo/credentials/kakao/map", { method: "PUT", body: { key: "0123456789abcdef0123456789abcdef" } });
    expect((await owner.browser.json("/v1/geo/map-config")).provider).toBe("kakao");
  });

  it("serves the page with the strict policy and the same cacheable answer, whoever asks", async () => {
    expect(STRICT_POLICY["content-security-policy"]).toBe(STRICT);
    const answers = [
      await mapped.request("/dashboard/"),
      await mapped.request("/dashboard"),
      await mapped.request("/dashboard/", { headers: { cookie: "wctx_session=forged" } }),
      await owner.browser.send("/dashboard/"),
      await owner.browser.send("/dashboard"),
    ];
    for (const res of answers) {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toBe(STRICT);
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(res.headers.get("vary")).toBeNull();
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.headers.get("etag")).toBe(answers[0]!.headers.get("etag"));
    }
  });

  it("serves the map frame with both providers' map hosts, framed only by this origin, sending only the origin", async () => {
    for (const res of [await mapped.request(MAP_FRAME_PATH), await owner.browser.send(MAP_FRAME_PATH)]) {
      expect(res.status).toBe(200);
      const csp = res.headers.get("content-security-policy")!;
      expect(directive(csp, "script-src")).toBe(
        "script-src 'self' https://dapi.kakao.com https://t1.kakaocdn.net https://oapi.map.naver.com https://nrbe.pstatic.net",
      );
      expect(directive(csp, "img-src")).toBe("img-src 'self' https://mts.kakaocdn.net https://t1.kakaocdn.net https://nrbe.pstatic.net https://ssl.pstatic.net");
      expect(directive(csp, "connect-src")).toBe("connect-src 'self' https://nrbe.pstatic.net");
      expect(directive(csp, "default-src")).toBe("default-src 'self'");
      expect(directive(csp, "frame-src")).toBe("frame-src 'none'");
      expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'self'");
      expect(csp).not.toMatch(/unsafe-eval|\*/);
      expect(res.headers.get("referrer-policy")).toBe("strict-origin");
      expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("keeps the strict policy on every other response", async () => {
    for (const path of ["/dashboard/assets/none.js", "/dashboard/map.html/x", "/dashboard/MAP.html", "/v1/geo", "/v1/geo/map-config", "/healthz"]) {
      const res = await owner.browser.send(path);
      expect(res.headers.get("content-security-policy"), path).toBe(STRICT);
      expect(res.headers.get("x-frame-options"), path).toBe("DENY");
    }
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

  it("the map frame loads one module script and runs nothing inline", () => {
    const frame = readFileSync(join(dir, "map.html"), "utf8");
    const scripts = [...frame.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]![1]).toMatch(/type="module"[^>]*src="\/dashboard\/assets\/map-[\w-]+\.js"/);
    expect(scripts[0]![2]).toBe("");
    expect(frame).not.toMatch(/\son[a-z]+\s*=|<style\b/i);
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
      // A map script's URL comes only from GET /v1/geo/map-config; the bundle names only the origins it may come from.
      expect(body, file).not.toMatch(/kakaocdn\.net|pstatic\.net|appkey=|ncpKeyId=/);
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
