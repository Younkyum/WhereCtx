import { describe, expect, it } from "vitest";
import {
  asUserId,
  type PresenceContext,
  type PrivacySettings,
  type TokenScope,
} from "../types.js";
import {
  accessAtLeast,
  agentCoarseView,
  authorizePrecise,
  buildCoarseView,
  buildPreciseView,
  canReadPresence,
  shouldHideExact,
} from "./policy.js";

const FIXED = new Date("2026-06-05T00:10:00.000Z");
const clock = () => FIXED;

const basePresence = (over: Partial<PresenceContext> = {}): PresenceContext => ({
  userId: asUserId("default"),
  status: "near_home",
  label: undefined,
  precise: { lat: 37.123456, lon: 127.123456, accuracyM: 21 },
  motion: "walking",
  source: "owntracks",
  privacy: { mode: "coarse", allowPreciseToAgents: false },
  updatedAt: "2026-06-05T00:09:18.000Z", // 42s before FIXED
  receivedAt: "2026-06-05T00:09:18.000Z",
  staleAfterSec: 900,
  ...over,
});

const settings = (over: Partial<PrivacySettings> = {}): PrivacySettings => ({
  defaultAgentAccess: "coarse",
  allowPreciseLocation: true,
  preciseRequiresReason: true,
  preciseRequiresApproval: false,
  hideHomeExactCoordinates: true,
  protectHomePlace: true,
  retentionHours: 24,
  storeRawHistory: false,
  ...over,
});

const PRECISE_SCOPES: TokenScope[] = ["read_presence", "read_precise_location"];

describe("accessAtLeast", () => {
  it("orders hidden < coarse < precise", () => {
    expect(accessAtLeast("precise", "coarse")).toBe(true);
    expect(accessAtLeast("coarse", "precise")).toBe(false);
    expect(accessAtLeast("hidden", "coarse")).toBe(false);
  });
});

describe("canReadPresence", () => {
  it("requires the read_presence scope (device tokens cannot read)", () => {
    expect(canReadPresence(["read_presence"])).toBe(true);
    expect(canReadPresence(["write_location"])).toBe(false);
  });
});

describe("buildCoarseView", () => {
  it("derives label fallback, age, and stale flag", () => {
    const v = buildCoarseView(basePresence(), clock);
    expect(v.label).toBe("near home");
    expect(v.updatedAgoSec).toBe(42);
    expect(v.stale).toBe(false);
  });

  it("marks stale when older than staleAfterSec", () => {
    const v = buildCoarseView(
      basePresence({ updatedAt: "2026-06-05T00:00:00.000Z", staleAfterSec: 300 }),
      clock,
    );
    expect(v.stale).toBe(true);
  });
});

describe("agentCoarseView (hidden-mode enforcement)", () => {
  it("returns a view for coarse/precise modes", () => {
    expect(agentCoarseView(basePresence(), settings({ defaultAgentAccess: "coarse" }), clock)).not.toBeNull();
    expect(agentCoarseView(basePresence(), settings({ defaultAgentAccess: "precise" }), clock)).not.toBeNull();
  });

  it("withholds presence entirely when mode is hidden", () => {
    expect(agentCoarseView(basePresence(), settings({ defaultAgentAccess: "hidden" }), clock)).toBeNull();
  });

  it("reflects the live policy mode, not the per-reading snapshot", () => {
    const stale = basePresence({ privacy: { mode: "precise", allowPreciseToAgents: true } });
    const v = agentCoarseView(stale, settings({ defaultAgentAccess: "coarse" }), clock);
    expect(v?.privacy).toBe("coarse");
  });
});

describe("authorizePrecise", () => {
  it("denies when presence is hidden from agents", () => {
    const r = authorizePrecise({
      scopes: PRECISE_SCOPES,
      settings: settings({ defaultAgentAccess: "hidden" }),
      presence: basePresence({ status: "away" }),
      reason: "map",
    });
    expect(r.allowed).toBe(false);
  });

  it("denies without the read_precise_location scope", () => {
    const r = authorizePrecise({
      scopes: ["read_presence"],
      settings: settings(),
      presence: basePresence({ status: "away" }),
      reason: "map",
    });
    expect(r.allowed).toBe(false);
  });

  it("denies when policy disables precise", () => {
    const r = authorizePrecise({
      scopes: PRECISE_SCOPES,
      settings: settings({ allowPreciseLocation: false }),
      presence: basePresence({ status: "away" }),
      reason: "map",
    });
    expect(r.allowed).toBe(false);
  });

  it("denies when interactive approval is required (no channel in v0.1)", () => {
    const r = authorizePrecise({
      scopes: PRECISE_SCOPES,
      settings: settings({ preciseRequiresApproval: true }),
      presence: basePresence({ status: "away" }),
      reason: "map",
    });
    expect(r.allowed).toBe(false);
  });

  it("denies when a reason is required but missing", () => {
    const r = authorizePrecise({
      scopes: PRECISE_SCOPES,
      settings: settings({ preciseRequiresReason: true }),
      presence: basePresence({ status: "away" }),
    });
    expect(r.allowed).toBe(false);
  });

  it("denies exact coordinates at home when home protection is on", () => {
    const r = authorizePrecise({
      scopes: PRECISE_SCOPES,
      settings: settings({ hideHomeExactCoordinates: true }),
      presence: basePresence({ status: "home" }),
      reason: "user_requested_map",
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/home/);
  });

  it("allows when scope + policy + reason are satisfied and not home-protected", () => {
    const r = authorizePrecise({
      scopes: PRECISE_SCOPES,
      settings: settings(),
      presence: basePresence({ status: "away" }),
      reason: "user_requested_map",
    });
    expect(r.allowed).toBe(true);
  });
});

describe("buildPreciseView + shouldHideExact", () => {
  it("returns exact coordinates (gating is done by authorizePrecise)", () => {
    const v = buildPreciseView(basePresence({ status: "away" }), clock);
    expect(v?.lat).toBe(37.123456);
    expect(v?.accuracyM).toBe(21);
    expect(v?.mapUrl).toContain("37.123456,127.123456");
  });

  it("returns null when no precise location is present", () => {
    expect(buildPreciseView(basePresence({ precise: undefined }), clock)).toBeNull();
  });

  it("flags home/near_home for protection but not away", () => {
    expect(shouldHideExact(basePresence({ status: "home" }), settings())).toBe(true);
    expect(shouldHideExact(basePresence({ status: "near_home" }), settings())).toBe(true);
    expect(shouldHideExact(basePresence({ status: "away" }), settings())).toBe(false);
    expect(
      shouldHideExact(basePresence({ status: "home" }), settings({ hideHomeExactCoordinates: false })),
    ).toBe(false);
  });
});
