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
import { pagePolicy } from "../app/securityHeaders.js";
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

  it("keeps the CSP: scripts from this origin only, images from this origin and the tile server", async () => {
    const res = await app.request("/dashboard/");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/script-src 'self';/);
    expect(csp).toMatch(/img-src 'self' https:\/\/tile\.openstreetmap\.org;/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("one strict policy for every response, opened only to the tile server", () => {
  const STRICT =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://tile.openstreetmap.org; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
  let owner: Enrolled;
  let served: Hono;

  beforeAll(async () => {
    const booted = await bootApp(new TestClock(), {}, { dashboardDir: dir });
    served = booted.app;
    owner = await setupOwner(served, booted.setupCode);
  });

  it("serves the page with the same strict, cacheable answer, whoever asks", async () => {
    const answers = [
      await served.request("/dashboard/"),
      await served.request("/dashboard"),
      await served.request("/dashboard/", { headers: { cookie: "wctx_session=forged" } }),
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

  it("keeps the same policy on every other response, and the old map frame is gone", async () => {
    for (const path of ["/dashboard/assets/none.js", "/dashboard/map.html", "/v1/geo", "/v1/geo/map-config", "/healthz"]) {
      const res = await owner.browser.send(path);
      expect(res.headers.get("content-security-policy"), path).toBe(STRICT);
      expect(res.headers.get("x-frame-options"), path).toBe("DENY");
    }
    expect((await served.request("/dashboard/map.html")).status).toBe(404);
  });

  it("opens img-src to exactly the configured tile origin, and to none when maps are off", async () => {
    const self = { attribution: "x", attributionUrl: null };
    const imgSrc = (tiles: Parameters<typeof pagePolicy>[0]) =>
      pagePolicy(tiles)["content-security-policy"].split("; ").find((d) => d.startsWith("img-src "));
    expect(imgSrc({ ...self, url: "https://tiles.example.org:8443/{z}/{x}/{y}.png", origin: "https://tiles.example.org:8443" })).toBe(
      "img-src 'self' https://tiles.example.org:8443",
    );
    expect(imgSrc(null)).toBe("img-src 'self'");
    const booted = await bootApp(new TestClock(), { mapTiles: null }, { dashboardDir: dir });
    const res = await booted.app.request("/dashboard/");
    expect(res.headers.get("content-security-policy")).toContain("img-src 'self';");
    expect(res.headers.get("content-security-policy")).not.toContain("openstreetmap");
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
      // No provider's map script: maps are the bundled Leaflet on tiles whose URL comes from GET /v1/geo/map-config.
      expect(body, file).not.toMatch(/dapi\.kakao\.com|kakaocdn\.net|pstatic\.net|oapi\.map\.naver|appkey=|ncpKeyId=/);
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

  it("loads no script and frames no page: maps are drawn in the page by the bundled Leaflet", () => {
    for (const [file, body] of webSource()) {
      expect(body, file).not.toMatch(/createElement\(\s*["'](script|iframe)["']|<iframe\b/);
    }
  });

  it("keeps the session in the cookie: no tokens in storage, no Authorization header", () => {
    for (const [file, body] of webSource()) {
      expect(body, file).not.toMatch(/wherectx_admin_token|sessionStorage/);
      expect(body, file).not.toMatch(/["']authorization["']\s*:/i);
    }
  });
});
