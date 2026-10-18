// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

type Handler = (body: unknown) => { status: number; body?: unknown };

let routes: Map<string, Handler>;
let calls: string[];
let root: Root;
let host: HTMLElement;

const ME = {
  user: { id: "u1", displayName: "<img src=x onerror=alert(1)>" },
  workspaces: [{ id: "w1", name: "Home", role: "owner" }],
  passkeys: [],
  sessions: [],
};

const buf = (...b: number[]) => new Uint8Array(b).buffer;

function route(key: string, handler: Handler) {
  routes.set(key, handler);
}

async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function button(name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
  if (!found) throw new Error(`no button "${name}" in: ${host.textContent}`);
  return found;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  routes = new Map();
  calls = [];
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    const key = `${init.method ?? "GET"} ${path}`;
    calls.push(key);
    const handler = routes.get(key);
    const out = handler ? handler(init.body ? JSON.parse(String(init.body)) : undefined) : { status: 404, body: { error: "not found" } };
    return new Response(out.body === undefined ? "" : JSON.stringify(out.body), { status: out.status });
  });
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: {
      get: vi.fn(async () => ({
        id: "cred",
        rawId: buf(1),
        type: "public-key",
        response: { clientDataJSON: buf(2), authenticatorData: buf(3), signature: buf(4), userHandle: null },
      })),
    },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("dashboard app", () => {
  it("shows sign-in without a session, signs in with a passkey, and lands on Home", async () => {
    let signedIn = false;
    route("GET /v1/me", () => (signedIn ? { status: 200, body: ME } : { status: 401, body: { error: "unauthorized" } }));
    route("POST /v1/auth/login/options", () => ({ status: 200, body: { ceremony: "c1", options: { challenge: "AQID" } } }));
    route("POST /v1/auth/login/verify", (body) => {
      expect(body).toMatchObject({ ceremony: "c1", response: { id: "cred", rawId: "AQ" } });
      signedIn = true;
      return { status: 200, body: { userId: "u1" } };
    });
    route("GET /v1/privacy", () => ({ status: 200, body: { settings: { sharingPaused: false } } }));
    route("GET /v1/presence", () => ({ status: 404, body: { error: "none" } }));
    route("GET /v1/people", () => ({ status: 200, body: { people: [] } }));

    await act(async () => root.render(<App />));
    await settle();
    expect(host.textContent).toContain("Sign in to WhereCtx");

    await act(async () => button("Sign in with a passkey").click());
    await settle();

    expect(calls).toContain("POST /v1/auth/login/verify");
    expect(host.querySelector("h1")?.textContent).toBe("Home");
    expect(host.textContent).toContain("No location yet");
    expect(host.textContent).toContain(ME.user.displayName);
    expect(host.querySelector("img")).toBeNull();
  });

  it("asks before deleting a place and deletes it only after the confirmation", async () => {
    let places = [{ name: "Gym", type: "custom", lat: 37.5, lon: 127, radiusM: 150 }];
    route("GET /v1/me", () => ({ status: 200, body: ME }));
    route("GET /v1/places", () => ({ status: 200, body: { places } }));
    route("DELETE /v1/places/Gym", () => {
      places = [];
      return { status: 200, body: { ok: true } };
    });
    location.hash = "#places";
    await act(async () => root.render(<App />));
    await settle();

    await act(async () => button("Delete").click());
    await settle();
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('Delete the place "Gym"?');
    expect(calls).not.toContain("DELETE /v1/places/Gym");

    const confirmButton = [...dialog!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Delete")!;
    await act(async () => confirmButton.click());
    await settle();
    expect(calls).toContain("DELETE /v1/places/Gym");
    expect(host.textContent).toContain("No places yet.");
    location.hash = "";
  });

  it("returns to sign-in when the session ends mid-use", async () => {
    let alive = true;
    route("GET /v1/me", () => ({ status: 200, body: ME }));
    route("GET /v1/privacy", () => (alive ? { status: 200, body: { settings: { sharingPaused: false } } } : { status: 401, body: {} }));
    route("GET /v1/presence", () => ({ status: 404, body: {} }));
    route("GET /v1/people", () => ({ status: 200, body: { people: [] } }));
    route("GET /v1/places", () => ({ status: 401, body: { error: "unauthorized" } }));

    await act(async () => root.render(<App />));
    await settle();
    expect(host.querySelector("h1")?.textContent).toBe("Home");

    alive = false;
    await act(async () => {
      location.hash = "#places";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await settle();
    expect(host.textContent).toContain("Sign in to WhereCtx");
  });

  it("on plain http, links the passkey warning to the README section that explains it", async () => {
    vi.stubGlobal("isSecureContext", false);
    route("GET /v1/me", () => ({ status: 401, body: { error: "unauthorized" } }));
    await act(async () => root.render(<App />));
    await settle();
    const link = [...host.querySelectorAll("a")].find((a) => a.textContent?.includes("How to serve WhereCtx over HTTPS"));
    expect(link?.getAttribute("href")).toBe("https://github.com/Younkyum/WhereCtx#passkeys-need-https-or-localhost");
    const readme = readFileSync(`${process.cwd()}/README.md`, "utf8");
    expect(readme).toContain("\n## Passkeys need HTTPS or localhost\n");
  });
});

describe("log views", () => {
  async function open(hash: string) {
    route("GET /v1/me", () => ({ status: 200, body: ME }));
    location.hash = hash;
    await act(async () => root.render(<App />));
    await settle();
  }

  afterEach(() => {
    location.hash = "";
  });

  it("History explains that history is off and links to Privacy", async () => {
    route("GET /v1/presence/history", () => ({
      status: 200,
      body: { enabled: false, retentionHours: 24, from: "", to: "", truncated: false, points: [] },
    }));
    route("GET /v1/places", () => ({ status: 200, body: { places: [] } }));
    await open("#history");
    expect(host.textContent).toContain("History is off");
    expect(host.querySelector('a[href="#privacy"]')).not.toBeNull();
    expect(host.querySelector('svg[role="img"] path')).toBeNull();
  });

  it("History draws the track and lists each point with a map link", async () => {
    const points = [
      { recordedAt: "2026-10-18T01:00:00.000Z", lat: 37.5, lon: 127, place: "home", mapUrl: "https://maps.google.com/?q=37.5,127" },
      { recordedAt: "2026-10-18T02:00:00.000Z", lat: 37.52, lon: 127.03, accuracyM: 12, mapUrl: "https://maps.google.com/?q=37.52,127.03" },
    ];
    route("GET /v1/presence/history", () => ({
      status: 200,
      body: { enabled: true, retentionHours: 24, from: "", to: "", truncated: false, points },
    }));
    route("GET /v1/places", () => ({ status: 200, body: { places: [{ name: "home", type: "home", lat: 37.5, lon: 127, radiusM: 100 }] } }));
    await open("#history");
    const path = host.querySelector('svg[role="img"] path');
    expect(path?.getAttribute("d")).toMatch(/^M[\d.]+ [\d.]+ L[\d.]+ [\d.]+$/);
    expect(host.textContent).toContain("At home");
    expect(host.textContent).toContain("37.52000, 127.03000");
    const links = [...host.querySelectorAll("a")].filter((a) => a.textContent?.includes("Map"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual(points.map((p) => p.mapUrl).reverse());
  });

  it("Agent access lists each read with its token, outcome and reason, and pages back", async () => {
    const entry = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      credential: { kind: "token", id: "t1", name: "Claude Desktop" },
      surface: "mcp",
      action: "get_presence",
      precise: false,
      outcome: "allowed",
      createdAt: "2026-10-18T01:00:00.000Z",
      ...over,
    });
    route("GET /v1/tokens", () => ({ status: 200, body: { tokens: [{ id: "t1", name: "Claude Desktop", role: "agent", lastUsedAt: null }] } }));
    route("GET /v1/activity/access?limit=50", () => ({
      status: 200,
      body: {
        entries: [entry("a", { action: "get_precise_location", precise: true, outcome: "denied", reason: "pick me up", denial: "precise location denied" })],
        next: "cursor-1",
      },
    }));
    route("GET /v1/activity/access?limit=50&before=cursor-1", () => ({ status: 200, body: { entries: [entry("b", { action: "presence.read", surface: "rest" })] } }));
    await open("#activity");
    expect(host.textContent).toContain("Asked for your exact location");
    expect(host.textContent).toContain("Refused");
    expect(host.textContent).toContain("Reason given: pick me up");
    expect(host.textContent).toContain("Claude Desktop · MCP");

    await act(async () => button("Show older").click());
    await settle();
    expect(host.textContent).toContain("Read your status");
    expect(host.textContent).toContain("Claude Desktop · REST API");
    expect(() => button("Show older")).toThrow();
  });

  it("Devices shows when each phone last sent and the recent uploads, never a location", async () => {
    route("GET /v1/devices", () => ({
      status: 200,
      body: {
        devices: [
          { id: "d1", name: "Pixel", createdAt: "", lastUsedAt: null, lastReceivedAt: "2026-10-18T01:00:00.000Z", lastOutcome: "rejected", accepted24h: 3, rejected24h: 1 },
          { id: "d2", name: "iPad", createdAt: "", lastUsedAt: null, lastReceivedAt: null, lastOutcome: null, accepted24h: 0, rejected24h: 0 },
        ],
      },
    }));
    route("GET /v1/activity/ingest?limit=20", () => ({
      status: 200,
      body: {
        entries: [
          { id: "i1", token: { id: "d1", name: "Pixel" }, source: "owntracks", outcome: "rejected", reason: "OwnTracks location missing lat/lon", receivedAt: "2026-10-18T01:00:00.000Z" },
          { id: "i2", token: null, source: "generic", outcome: "accepted", receivedAt: "2026-10-18T00:30:00.000Z" },
        ],
      },
    }));
    await open("#devices");
    expect(host.textContent).toContain("Last 24 hours: 3 accepted, 1 rejected");
    expect(host.textContent).toContain("Nothing received yet");
    expect(host.textContent).toContain("This dashboard");
    expect(host.textContent).toContain("OwnTracks location missing lat/lon");
    expect(host.textContent).toContain("Rejected");
  });
});
