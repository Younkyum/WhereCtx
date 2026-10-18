// @vitest-environment happy-dom
import QRCode from "qrcode";
import { describe, expect, it } from "vitest";
import { MANAGEABLE_ROLES, WORKSPACE_ROLES, can, canManage } from "../../src/accounts/types";
import * as lib from "./lib";

describe("dashboard helpers", () => {
  it("only turns http(s) URLs into links", () => {
    expect(lib.safeHttpUrl("https://maps.google.com/?q=1,2")).toBe("https://maps.google.com/?q=1,2");
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:x", "data:text/html,x", "//evil", "", null, 42]) {
      expect(lib.safeHttpUrl(bad)).toBe("");
    }
  });

  it("round-trips base64url, including bytes that need + / and padding", () => {
    const bytes = Uint8Array.from([0xfb, 0xff, 0xbf, 0x00, 0x3e, 0x3f, 0x01]);
    const text = lib.bytesToB64url(bytes.buffer);
    expect(text).toBe("-_-_AD4_AQ");
    expect([...lib.b64urlToBytes(text)]).toEqual([...bytes]);
    const view = new Uint8Array([9, 9, 1, 2, 3]).subarray(2);
    expect(lib.bytesToB64url(view)).toBe("AQID");
  });

  it("decodes WebAuthn options into the byte fields navigator.credentials needs", () => {
    const creation = lib.creationOptionsFromJSON({
      challenge: "AQID",
      rp: { name: "WhereCtx", id: "localhost" },
      user: { id: "BAUG", name: "a", displayName: "a" },
      pubKeyCredParams: [{ alg: -7, type: "public-key" }],
      excludeCredentials: [{ id: "BwgJ", type: "public-key" }],
    });
    expect([...(creation.challenge as Uint8Array)]).toEqual([1, 2, 3]);
    expect([...(creation.user.id as Uint8Array)]).toEqual([4, 5, 6]);
    expect(creation.user.name).toBe("a");
    expect([...(creation.excludeCredentials![0]!.id as Uint8Array)]).toEqual([7, 8, 9]);
    const request = lib.requestOptionsFromJSON({ challenge: "AQID", rpId: "localhost" });
    expect([...(request.challenge as Uint8Array)]).toEqual([1, 2, 3]);
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
    expect(lib.statusOf("custom")).toBe("custom");
    expect(lib.statusOf("<b>")).toBe("unknown");
    expect(lib.motionOf("walking")).toBe("walking");
    expect(lib.motionOf("teleporting")).toBeNull();
    expect(lib.errorKey({ status: 403, code: "reauth_required", message: "" })).toBe("err.reauth");
    expect(lib.errorKey({ status: 409, code: "last_owner", message: "" })).toBe("err.lastOwner");
    expect(lib.errorKey({ status: 400, code: "base_url_unusable", message: "" })).toBe("err.baseUrl");
    expect(lib.errorKey({ status: 400, code: "__proto__", message: "" })).toBe("err.invalid");
    expect(lib.errorKey({ status: 429, code: null, message: "" })).toBe("err.rateLimited");
    expect(lib.errorKey({ status: 409, code: null, message: "" })).toBeNull();
    expect(lib.passkeyErrorKey({ name: "NotAllowedError" })).toBe("err.passkeyCancelled");
    expect(lib.passkeyErrorKey(new Error("x"))).toBeNull();
    expect(lib.geoErrorKey(1)).toBe("geo.denied");
    expect(lib.deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("iPhone");
    expect(lib.deviceLabel(undefined)).toBe("");
  });

  it("offers member controls exactly where the server's role registry allows them", () => {
    for (const actor of WORKSPACE_ROLES) {
      expect(lib.inviteRoles(actor)).toEqual(can(actor, "invite") ? [...MANAGEABLE_ROLES[actor]] : []);
      for (const target of WORKSPACE_ROLES) {
        const other = { userId: "other", displayName: "O", role: target, joinedAt: "" };
        const a = lib.memberActions(actor, "me", other);
        expect(a.changeRole, `${actor}->${target}`).toBe(can(actor, "changeRole") && canManage(actor, target));
        expect(a.remove, `${actor}->${target}`).toBe(can(actor, "removeMember") && canManage(actor, target));
        const self = lib.memberActions(actor, "me", { ...other, userId: "me" });
        expect(self).toMatchObject({ self: true, changeRole: false, remove: false });
      }
    }
  });
});

describe("pairing QR code", () => {
  it("reads the server's QR SVG into path data that redraws it", async () => {
    const svg = await QRCode.toString("owntracks:///config?inline=abc", { type: "svg", errorCorrectionLevel: "M", margin: 2 });
    const qr = lib.qrFromSvg(svg)!;
    expect(qr.viewBox).toMatch(/^0 0 \d+ \d+$/);
    expect(qr.paths.length).toBeGreaterThan(0);
    expect(qr.paths.every((p) => /^[MmHhVvLlZz0-9.,\s-]+$/.test(p.d))).toBe(true);
    expect(qr.paths.some((p) => p.stroke)).toBe(true);
  });

  it("refuses anything but plain path geometry", () => {
    const bad = [
      null,
      "",
      "<html><body>x</body></html>",
      '<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>',
      '<svg viewBox="0 0 1 1" onload="alert(1)"></svg>',
      '<svg viewBox="0 0 1 1"><path d="javascript:alert(1)"/></svg>',
      '<svg viewBox="url(x)"><path d="M0 0h1"/></svg>',
      "<svg",
    ];
    for (const svg of bad) expect(lib.qrFromSvg(svg), String(svg)).toBeNull();
    const kept = lib.qrFromSvg('<svg viewBox="0 0 2 2"><path d="M0 0h1" fill="url(#x)" stroke="#000" onclick="x()"/></svg>')!;
    expect(kept.paths).toEqual([{ d: "M0 0h1", stroke: "#000" }]);
  });
});
