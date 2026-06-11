import { beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { WhereCtxConfig } from "../config.js";
import { createAppContext } from "../app/context.js";
import { buildApp } from "../app/server.js";
import { DASHBOARD_HTML, DASHBOARD_JS } from "./page.js";

const config: WhereCtxConfig = {
  port: 0,
  host: "127.0.0.1",
  baseUrl: "http://localhost:8787",
  databaseUrl: ":memory:",
  userId: "default",
  bootstrapTokens: {},
  privacy: {
    defaultAgentAccess: "coarse",
    preciseRequiresReason: true,
    allowPreciseToAgent: false,
    hideHomeExactCoordinates: true,
    protectHomePlace: true,
    staleAfterSec: 900,
    retentionHours: 24,
    storeRawHistory: false,
  },
  geofence: { nearRadiusMultiplier: 3 },
  webhooks: { allowPrivateTargets: false },
  events: { retentionHours: 720 },
};

let app: Hono;

beforeEach(async () => {
  const { ctx } = await createAppContext(config);
  app = buildApp(ctx);
});

describe("dashboard", () => {
  it("serves the admin page as HTML with the expected elements", async () => {
    const res = await app.request("/dashboard");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    for (const id of ['id="heroStatus"', 'id="privacyForm"', 'id="places"', 'id="tokens"', 'id="webhooks"']) {
      expect(html).toContain(id);
    }
  });

  it("serves the client script separately (CSP: no inline scripts)", async () => {
    const res = await app.request("/dashboard/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(DASHBOARD_HTML).toContain('src="/dashboard/app.js"');
    expect(DASHBOARD_HTML).not.toContain("<script>\n"); // no inline script blocks
  });

  it("ships English + Korean i18n with a language toggle", () => {
    // Both language tables present (script is served separately).
    expect(DASHBOARD_JS).toMatch(/I18N\s*=\s*\{/);
    expect(DASHBOARD_JS).toContain("en:");
    expect(DASHBOARD_JS).toContain("ko:");
    // Representative Korean + English strings present in both tables.
    expect(DASHBOARD_JS).toContain("프라이버시"); // privacy.title (ko)
    expect(DASHBOARD_JS).toContain("관리자 토큰"); // connect.placeholder (ko)
    expect(DASHBOARD_HTML).toContain("Default agent access"); // privacy.access (en)
    // Language toggle + i18n-tagged elements.
    expect(DASHBOARD_HTML).toContain('data-lang="ko"');
    expect(DASHBOARD_HTML).toContain('data-lang="en"');
    expect(DASHBOARD_HTML).toContain("data-i18n=");
    // Language preference is persisted.
    expect(DASHBOARD_JS).toContain("wherectx_lang");
  });

  it("exposes the home place protection toggle", () => {
    expect(DASHBOARD_HTML).toContain('name="protectHomePlace"');
    expect(DASHBOARD_JS).toContain("protectHomePlace");
  });

  it("sends a Content-Security-Policy and security headers", async () => {
    const res = await app.request("/dashboard");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    // Scripts must be 'self'-only — no 'unsafe-inline' escape hatch (M5).
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self';");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("escapes &<>\"' in its client-side esc() helper (XSS defense)", () => {
    // Lock the esc() replacement map so a future edit can't drop a char.
    expect(DASHBOARD_JS).toContain("&#39;"); // single quote escaped
    expect(DASHBOARD_JS).toMatch(/replace\(\/\[&<>"'\]\/g/);
  });
});
