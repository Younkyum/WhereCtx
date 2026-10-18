import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createAppContext } from "../app/context.js";
import { buildApp } from "../app/server.js";
import { AuthenticationResponse, RegistrationResponse } from "../api/accountHttp.js";
import { MANAGEABLE_ROLES, WORKSPACE_ROLES, can, canManage } from "../accounts/types.js";
import { Browser, testConfig } from "../testing/accounts.js";
import { SoftAuthenticator } from "../testing/softAuthenticator.js";
import { DASHBOARD_ASSETS } from "./assets.js";
import { I18N } from "./i18n.js";
import { DASHBOARD_HTML } from "./page.js";

const ORIGIN = "http://localhost:8787";
const SCRIPTS = Object.entries(DASHBOARD_ASSETS).filter(([name]) => name.endsWith(".js"));

let dir: string;
let lib: any;
let app: Hono;
let setupCode: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "wherectx-dashboard-"));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  for (const [name, asset] of Object.entries(DASHBOARD_ASSETS)) writeFileSync(join(dir, name), asset.body);
  lib = await import(pathToFileURL(join(dir, "lib.js")).href);
  const booted = await createAppContext(testConfig());
  app = buildApp(booted.ctx);
  setupCode = booted.bootstrap.setupCode!;
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("dashboard router", () => {
  it("serves the shell at /dashboard and /dashboard/ (the invite link form)", async () => {
    for (const path of ["/dashboard", "/dashboard/"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toBe(DASHBOARD_HTML);
    }
  });

  it("serves every asset with its content type, revalidated on each load", async () => {
    for (const [name, asset] of Object.entries(DASHBOARD_ASSETS)) {
      const res = await app.request(`/dashboard/${name}`);
      expect(res.status, name).toBe(200);
      expect(res.headers.get("content-type")).toBe(asset.contentType);
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(res.headers.get("etag")).toBeTruthy();
      expect(await res.text()).toBe(asset.body);
    }
    expect(DASHBOARD_ASSETS["style.css"]!.contentType).toContain("text/css");
  });

  it("answers 404 for unknown files, including object prototype names", async () => {
    for (const name of ["nope.js", "__proto__", "constructor", "toString"]) {
      expect((await app.request(`/dashboard/${name}`)).status, name).toBe(404);
    }
  });

  it("keeps the CSP script-src 'self' with no inline script or handler anywhere", async () => {
    const res = await app.request("/dashboard");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/script-src 'self';/);
    expect(csp).toContain("img-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    const scripts = [...DASHBOARD_HTML.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts).toEqual(['<script type="module" src="/dashboard/app.js">']);
    expect(DASHBOARD_HTML).not.toMatch(/<script>[^<]/);
    for (const [name, asset] of [["page", { body: DASHBOARD_HTML }] as const, ...Object.entries(DASHBOARD_ASSETS)]) {
      expect(asset.body, name).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
      expect(asset.body, name).not.toMatch(/javascript:/i);
      expect(asset.body, name).not.toMatch(/data:image/i);
      expect(asset.body, name).not.toMatch(/https?:\/\/(?!maps\.)[a-z]/i);
    }
  });

  it("has no admin-token paste and no token in browser storage", () => {
    const all = SCRIPTS.map(([, a]) => a.body).join("\n");
    expect(all).not.toContain("wherectx_admin_token");
    expect(all).not.toMatch(/authorization['"]?\s*:/i);
    expect(all).toContain("credentials: 'same-origin'");
  });

  it("links only files it serves: the page's assets and every module import", () => {
    expect(DASHBOARD_HTML).toContain('href="/dashboard/style.css"');
    for (const [name, asset] of SCRIPTS) {
      for (const m of asset.body.matchAll(/from '\.\/([\w-]+\.js)'/g)) {
        expect(DASHBOARD_ASSETS, `${name} imports ${m[1]}`).toHaveProperty([m[1]!]);
      }
    }
  });

  it("ships only syntactically valid ES modules", () => {
    for (const [name] of SCRIPTS) {
      const r = spawnSync(process.execPath, ["--check", join(dir, name)], { encoding: "utf8" });
      expect(r.stderr, name).toBe("");
      expect(r.status, name).toBe(0);
    }
  });

  it("keeps every client file under 600 lines", () => {
    for (const [name, asset] of Object.entries(DASHBOARD_ASSETS)) {
      expect(asset.body.split("\n").length, name).toBeLessThan(600);
    }
  });
});

describe("i18n", () => {
  const en = I18N.en as Record<string, string>;
  const ko = I18N.ko as Record<string, string>;
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it("has the same keys and placeholders in English and Korean, none empty", () => {
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      expect(en[key]!.trim(), key).not.toBe("");
      expect(ko[key]!.trim(), key).not.toBe("");
      expect(placeholders(ko[key]!), key).toEqual(placeholders(en[key]!));
    }
  });

  it("serves the same tables to the browser", async () => {
    const served = await import(pathToFileURL(join(dir, "i18n.js")).href);
    expect(served.I18N).toEqual(I18N);
  });

  it("shows the custom status as a custom place, not the raw API value", () => {
    expect(en["st.custom"]).toBe("At a custom place");
    expect(ko["st.custom"]).toBe("지정 장소");
  });

  it("defines every key the client names literally", () => {
    const namespaces = new Set(Object.keys(en).map((k) => k.split(".")[0]));
    const missing: string[] = [];
    for (const [name, asset] of SCRIPTS) {
      for (const m of asset.body.matchAll(/'([a-z][A-Za-z]*(?:\.[A-Za-z_]+)+)'/g)) {
        const key = m[1]!;
        if (namespaces.has(key.split(".")[0]!) && !(key in en)) missing.push(`${name}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("covers every key the client builds from a value", () => {
    const families: Record<string, readonly string[]> = {
      "st.": lib.STATUSES,
      "role.": WORKSPACE_ROLES,
      "level.": ["coarse", "precise"],
      "sharing.level.": ["off", "coarse", "precise"],
      "access.": ["hidden", "coarse", "precise"],
      "ptype.": ["home", "work", "custom"],
      "tokenRole.": ["device", "agent", "admin"],
      "motion.": ["stationary", "walking", "running", "driving", "transit"],
      "audit.action.": ["granted", "changed", "revoked", "precise_viewed"],
      "audit.reason.": ["membership_ended", "viewer_declined"],
      "people.withheld.": ["at_home", "no_home_place"],
      "gate.err.": ["signin", "setup", "invite", "recover", "access", "codes"],
      "privacy.": ["allowPreciseLocation", "preciseRequiresReason", "preciseRequiresApproval", "hideHomeExactCoordinates", "protectHomePlace", "storeRawHistory"],
    };
    for (const [prefix, values] of Object.entries(families)) {
      for (const v of values) expect(en, prefix + v).toHaveProperty([prefix + v]);
    }
  });
});

describe("client helpers (lib.js as served)", () => {
  it("escapes &<>\"' for HTML text and attributes", () => {
    expect(lib.esc(`<img src=x onerror="a('b')">&`)).toBe(
      "&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;",
    );
    expect(lib.esc(null)).toBe("");
    expect(lib.esc(42)).toBe("42");
  });

  it("only turns http(s) URLs into links", () => {
    expect(lib.safeHttpUrl("https://maps.google.com/?q=1,2")).toBe("https://maps.google.com/?q=1,2");
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:x", "data:text/html,x", "//evil", "", null]) {
      expect(lib.safeHttpUrl(bad)).toBe("");
    }
  });

  it("round-trips base64url, including bytes that need + / and padding", () => {
    const bytes = Uint8Array.from([0xfb, 0xff, 0xbf, 0x00, 0x3e, 0x3f, 0x01]);
    const text = lib.bytesToB64url(bytes.buffer);
    expect(text).toBe(Buffer.from(bytes).toString("base64url"));
    expect(text).not.toMatch(/[+/=]/);
    expect([...lib.b64urlToBytes(text)]).toEqual([...bytes]);
    const view = new Uint8Array([9, 9, 1, 2, 3]).subarray(2);
    expect(lib.bytesToB64url(view)).toBe(Buffer.from([1, 2, 3]).toString("base64url"));
  });

  it("decodes WebAuthn options into the byte fields navigator.credentials needs", () => {
    const creation = lib.creationOptionsFromJSON({
      challenge: "AQID",
      rp: { name: "WhereCtx", id: "localhost" },
      user: { id: "BAUG", name: "a", displayName: "a" },
      pubKeyCredParams: [{ alg: -7, type: "public-key" }],
      excludeCredentials: [{ id: "BwgJ", type: "public-key" }],
    });
    expect([...creation.challenge]).toEqual([1, 2, 3]);
    expect([...creation.user.id]).toEqual([4, 5, 6]);
    expect(creation.user.name).toBe("a");
    expect([...creation.excludeCredentials[0].id]).toEqual([7, 8, 9]);
    const request = lib.requestOptionsFromJSON({ challenge: "AQID", rpId: "localhost" });
    expect([...request.challenge]).toEqual([1, 2, 3]);
    expect(request.allowCredentials).toEqual([]);
  });

  it("reports why passkeys cannot work on a page", () => {
    const pk = { PublicKeyCredential: function () {}, navigator: { credentials: {} } };
    expect(lib.webauthnProblem({ isSecureContext: false, ...pk })).toBe("insecure");
    expect(lib.webauthnProblem({ isSecureContext: true, navigator: {} })).toBe("unsupported");
    expect(lib.webauthnProblem({ isSecureContext: true, ...pk })).toBeNull();
  });

  it("reads invite tokens from the fragment only", () => {
    expect(lib.parseInviteHash("#invite=abc_DEF-123")).toBe("abc_DEF-123");
    expect(lib.parseInviteHash("#home")).toBeNull();
    expect(lib.parseInviteHash("")).toBeNull();
    expect(lib.parseInviteHash("#invite=%E0%A4%A")).toBeNull();
  });

  it("maps ages, statuses and errors to i18n keys", () => {
    expect(lib.ageParts(0)).toEqual(["age.now", 0]);
    expect(lib.ageParts(59)).toEqual(["age.min", 59]);
    expect(lib.ageParts(61)).toEqual(["age.hour", 1]);
    expect(lib.ageParts(1440 * 3)).toEqual(["age.day", 3]);
    expect(lib.statusKey("custom")).toBe("st.custom");
    expect(lib.statusKey("<b>")).toBe("st.unknown");
    expect(lib.errorKey({ status: 403, code: "reauth_required" })).toBe("err.reauth");
    expect(lib.errorKey({ status: 409, code: "last_owner" })).toBe("err.lastOwner");
    expect(lib.errorKey({ status: 400, code: "base_url_unusable" })).toBe("err.baseUrl");
    expect(lib.errorKey({ status: 429 })).toBe("err.rateLimited");
    expect(lib.errorKey({ status: 409 })).toBeNull();
    expect(lib.passkeyErrorKey({ name: "NotAllowedError" })).toBe("err.passkeyCancelled");
    expect(lib.geoErrorKey(1)).toBe("geo.denied");
    expect(lib.deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("iPhone");
    expect(lib.deviceLabel(undefined)).toBe("");
  });

  it("offers member controls exactly where the server's role registry allows them", () => {
    for (const actor of WORKSPACE_ROLES) {
      expect(lib.inviteRoles(actor)).toEqual(can(actor, "invite") ? [...MANAGEABLE_ROLES[actor]] : []);
      for (const target of WORKSPACE_ROLES) {
        const a = lib.memberActions(actor, "me", { userId: "other", role: target });
        expect(a.changeRole, `${actor}->${target}`).toBe(can(actor, "changeRole") && canManage(actor, target));
        expect(a.remove, `${actor}->${target}`).toBe(can(actor, "removeMember") && canManage(actor, target));
        const self = lib.memberActions(actor, "me", { userId: "me", role: target });
        expect(self).toMatchObject({ self: true, changeRole: false, remove: false });
      }
    }
  });
});

/** Turn the soft authenticator's JSON into what a browser's PublicKeyCredential looks like. */
function browserCredential(json: any): any {
  const buf = (s: string) => lib.b64urlToBytes(s).buffer;
  const r = json.response;
  const response: any = { clientDataJSON: buf(r.clientDataJSON) };
  if (r.attestationObject) {
    response.attestationObject = buf(r.attestationObject);
    response.getTransports = () => ["internal"];
  } else {
    response.authenticatorData = buf(r.authenticatorData);
    response.signature = buf(r.signature);
    response.userHandle = buf(r.userHandle);
  }
  return {
    id: json.id,
    rawId: buf(json.rawId),
    type: "public-key",
    authenticatorAttachment: "platform",
    getClientExtensionResults: () => ({}),
    response,
  };
}

describe("dashboard WebAuthn conversions against the real verifier", () => {
  it("sets up the owner, signs in and steps up with credentials shaped by lib.js", async () => {
    const auth = new SoftAuthenticator();
    const browser = new Browser(app);

    const setup = await browser.json("/v1/auth/setup/options", { body: { code: setupCode } });
    const creation = lib.creationOptionsFromJSON(setup.options);
    const created = auth.create(
      { challenge: lib.bytesToB64url(creation.challenge), user: { id: lib.bytesToB64url(creation.user.id) } },
      { origin: ORIGIN },
    );
    const registration = lib.registrationToJSON(browserCredential(created));
    expect(RegistrationResponse.safeParse(registration).success).toBe(true);
    const enrolled = await browser.json("/v1/auth/setup/verify", {
      body: { code: setupCode, ceremony: setup.ceremony, response: registration, passkeyName: "Mac" },
    });
    expect(enrolled.recoveryCodes).toHaveLength(8);

    const signIn = new Browser(app);
    const login = await signIn.json("/v1/auth/login/options", { body: {} });
    const request = lib.requestOptionsFromJSON(login.options);
    const asserted = auth.get({ challenge: lib.bytesToB64url(request.challenge) }, created.id, { origin: ORIGIN });
    const assertion = lib.authenticationToJSON(browserCredential(asserted));
    expect(AuthenticationResponse.safeParse(assertion).success).toBe(true);
    expect((await signIn.json("/v1/auth/login/verify", { body: { ceremony: login.ceremony, response: assertion } })).userId).toBe(
      enrolled.userId,
    );

    const step = await signIn.json("/v1/me/reauth/options", { body: {} });
    const again = auth.get({ challenge: lib.bytesToB64url(lib.requestOptionsFromJSON(step.options).challenge) }, created.id, {
      origin: ORIGIN,
    });
    expect(
      (await signIn.json("/v1/me/reauth/verify", {
        body: { ceremony: step.ceremony, response: lib.authenticationToJSON(browserCredential(again)) },
      })).ok,
    ).toBe(true);
    const me = await signIn.json("/v1/me");
    expect(me.passkeys.map((p: any) => p.name)).toEqual(["Mac"]);
  });

  it("omits an empty userHandle and a null attachment rather than sending nulls", () => {
    const out = lib.authenticationToJSON({
      id: "AQ",
      rawId: new Uint8Array([1]).buffer,
      type: "public-key",
      authenticatorAttachment: null,
      response: {
        clientDataJSON: new Uint8Array([1]).buffer,
        authenticatorData: new Uint8Array([2]).buffer,
        signature: new Uint8Array([3]).buffer,
        userHandle: null,
      },
    });
    expect(out).not.toHaveProperty("authenticatorAttachment");
    expect(out.response).not.toHaveProperty("userHandle");
    expect(out.clientExtensionResults).toEqual({});
    expect(AuthenticationResponse.safeParse(out).success).toBe(true);
  });
});

describe("XSS discipline in the client source", () => {
  const source = SCRIPTS.map(([name, a]) => [name, a.body] as const);

  it("never concatenates translated or formatted text into markup unescaped", () => {
    for (const [name, body] of source) {
      expect(body, name).not.toMatch(/(?<!\.)['"]\s*\+\s*(?:t|statusLabel|ago|fmtTime|fmtDate|describe)\(/);
    }
  });

  // A literal ending in "." builds an i18n key ('role.' + m.role), which is not markup.
  it("never concatenates a server field into a string without esc()", () => {
    const field = /(?<!\.)['"]\s*\+\s*(?:[a-z]\w*\.)+(?:displayName|name|workspaceName|url|link|placeName|error|userAgent|id|userId|role|level|type|status|eventType|message|mapUrl|secret)\b(?!\s*\()/;
    for (const [name, body] of source) {
      const hits = body.split("\n").filter((line) => field.test(line));
      expect(hits, name).toEqual([]);
    }
  });

  it("inserts only one server string as markup: the pairing QR code, checked to be an <svg>", () => {
    const devices = DASHBOARD_ASSETS["devices.js"]!.body;
    expect(devices).toMatch(/\/\^\\s\*<svg\[\\s>\]\/\.test\(r\.qrSvg\)/);
  });
});
