// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

type Reply = { status: number; body?: unknown };
type Handler = (body: unknown) => Reply | Promise<Reply>;

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
    const handler = routes.get(key) ?? routes.get(key.split("?")[0]!);
    const out = handler ? await handler(init.body ? JSON.parse(String(init.body)) : undefined) : { status: 404, body: { error: "not found" } };
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

  const CONSENT_REQUEST = {
    client: { id: "https://client.example/meta.json", name: "Test Agent", uri: "https://agent-site.example" },
    redirectUri: "http://127.0.0.1:9876/cb",
    redirectHost: "127.0.0.1:9876",
    localhostOnly: true,
    requestedScopes: ["presence:read", "location:precise"],
    resource: "https://where.example.com/mcp",
  };

  it("shows a pending authorization's consent screen and confirms after a passkey step-up", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", Object.assign(new URL(location.href), { hash: "#authorize/u1", assign }));
    route("GET /v1/me", () => ({ status: 200, body: ME }));
    route("GET /oauth/interaction/u1/details", () => ({ status: 200, body: CONSENT_REQUEST }));
    let reauthed = false;
    route("POST /v1/me/reauth/options", () => ({ status: 200, body: { ceremony: "c1", options: { challenge: "AQID" } } }));
    route("POST /v1/me/reauth/verify", () => {
      reauthed = true;
      return { status: 200, body: { ok: true } };
    });
    const confirmed: unknown[] = [];
    route("POST /oauth/interaction/u1/confirm", (body) => {
      confirmed.push(body);
      return reauthed
        ? { status: 200, body: { redirectTo: "https://where.example.com/oauth/authorize/u1" } }
        : { status: 403, body: { error: "confirm with your passkey first", code: "reauth_required" } };
    });

    await act(async () => root.render(<App />));
    await settle();
    expect(host.querySelector("h1")?.textContent).toBe("Connect Test Agent?");
    expect(host.textContent).toContain("Verified app ID");
    expect(host.textContent).toContain("client.example");
    expect(host.textContent).toContain("Website (the app's claim)");
    expect(host.textContent).toContain("agent-site.example");
    expect(host.textContent).toContain("127.0.0.1:9876");
    expect(host.textContent).toContain(ME.user.displayName);
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("This app runs on a computer, not a website");
    expect(host.textContent).toContain("Create location reminders, and new places other than home");
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(false);
    await act(async () => checkbox.click());

    await act(async () => button("Allow").click());
    await settle();
    expect(calls).toContain("POST /v1/me/reauth/verify");
    expect(confirmed).toEqual([{ precise: true }, { precise: true }]);
    expect(assign).toHaveBeenCalledWith("https://where.example.com/oauth/authorize/u1");
  });

  it("lists only what the requested scopes allow", async () => {
    vi.stubGlobal("location", Object.assign(new URL(location.href), { hash: "#authorize/u1", assign: vi.fn() }));
    route("GET /v1/me", () => ({ status: 200, body: ME }));
    route("GET /oauth/interaction/u1/details", () => ({
      status: 200,
      body: { ...CONSENT_REQUEST, requestedScopes: ["location:precise"] },
    }));
    await act(async () => root.render(<App />));
    await settle();
    expect(host.textContent).not.toContain("See your presence");
    expect(host.textContent).toContain("Also allow precise location");
  });

  it("shows an answered or expired authorization as expired and disables Allow", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", Object.assign(new URL(location.href), { hash: "#authorize/u1", assign }));
    route("GET /v1/me", () => ({ status: 200, body: ME }));
    route("GET /oauth/interaction/u1/details", () => ({ status: 200, body: CONSENT_REQUEST }));
    route("POST /oauth/interaction/u1/confirm", () => ({
      status: 404,
      body: { error: "expired", code: "interaction_expired" },
    }));
    await act(async () => root.render(<App />));
    await settle();
    await act(async () => button("Allow").click());
    await settle();
    expect(host.textContent).toContain("This request expired or was started in another browser.");
    expect(button("Allow").disabled).toBe(true);
    expect(button("Deny").disabled).toBe(true);
    expect(assign).not.toHaveBeenCalled();
  });

  it("lists connected apps on the Agents screen and disconnects one after confirmation", async () => {
    let grants = [
      {
        id: "g1",
        clientId: "https://client.example/meta.json",
        clientName: "Test Agent",
        scopes: ["presence:read"],
        createdAt: "2026-10-18T00:00:00.000Z",
        expiresAt: "2026-11-17T00:00:00.000Z",
      },
    ];
    route("GET /v1/me", () => ({ status: 200, body: ME }));
    route("GET /v1/tokens", () => ({ status: 200, body: { tokens: [] } }));
    route("GET /v1/oauth/grants", () => ({ status: 200, body: { grants } }));
    route("DELETE /v1/oauth/grants/g1", () => {
      grants = [];
      return { status: 200, body: { ok: true } };
    });
    location.hash = "#agents";
    await act(async () => root.render(<App />));
    await settle();
    expect(host.textContent).toContain("Connected apps");
    expect(host.textContent).toContain("Test Agent");
    expect(host.textContent).toContain("client.example");

    await act(async () => button("Revoke").click());
    await settle();
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('Disconnect "Test Agent"?');
    const confirmButton = [...dialog!.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Revoke")!;
    await act(async () => confirmButton.click());
    await settle();
    expect(calls).toContain("DELETE /v1/oauth/grants/g1");
    expect(host.textContent).toContain("No connected apps yet.");
    location.hash = "";
  });

  it("shows how long ago, never a stale badge, for me and for people who share with me", async () => {
    route("GET /v1/me", () => ({ status: 200, body: ME }));
    route("GET /v1/privacy", () => ({ status: 200, body: { settings: { sharingPaused: false } } }));
    route("GET /v1/presence", () => ({
      status: 200,
      body: { status: "home", label: "home", motion: "stationary", updatedAgoSec: 12 * 60, stale: true, freshness: "offline", privacy: "coarse" },
    }));
    route("GET /v1/people", () => ({
      status: 200,
      body: {
        people: [
          {
            user: { id: "u2", displayName: "Mina" },
            level: "coarse",
            paused: false,
            presence: { status: "away", label: "away", motion: "unknown", updatedAgoMin: 3 * 1440, stale: true, freshness: "offline" },
            precise: null,
          },
        ],
      },
    }));
    await act(async () => root.render(<App />));
    await settle();
    expect(host.textContent).toContain("12 min ago");
    expect(host.textContent).not.toMatch(/stale|fresh/i);
    expect(host.textContent).not.toMatch(/\d+ d ago/);
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
      { id: "p1", recordedAt: "2026-10-18T01:00:00.000Z", lat: 37.5, lon: 127, place: "home" },
      { id: "p2", recordedAt: "2026-10-18T01:00:00.000Z", lat: 37.52, lon: 127.03, accuracyM: 12 },
    ];
    route("GET /v1/presence/history", () => ({
      status: 200,
      body: { enabled: true, retentionHours: 24, from: "", to: "", truncated: true, points },
    }));
    route("GET /v1/places", () => ({ status: 200, body: { places: [{ name: "home", type: "home", lat: 37.5, lon: 127, radiusM: 100 }] } }));
    const consoleError = vi.spyOn(console, "error");
    await open("#history");
    expect(consoleError.mock.calls.flat().join(" ")).not.toMatch(/same key/);
    const path = host.querySelector('svg[role="img"] path');
    expect(path?.getAttribute("d")).toMatch(/^M[\d.]+ [\d.]+ L[\d.]+ [\d.]+$/);
    expect(host.textContent).toContain("At home");
    expect(host.textContent).toContain("37.52000, 127.03000");
    const links = [...host.querySelectorAll("a")].filter((a) => a.textContent?.includes("Map"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "https://maps.google.com/?q=37.52,127.03",
      "https://maps.google.com/?q=37.5,127",
    ]);
    expect(host.textContent).toContain("Showing the newest 2");
    const asked = () => calls.filter((c) => c.startsWith("GET /v1/presence/history?")).map((c) => new URLSearchParams(c.split("?")[1]));
    expect(asked().at(-1)!.get("limit")).toBe("5000");
    expect(asked().at(-1)!.has("to")).toBe(false);

    await act(async () => button("1 h").click());
    await settle();
    const hour = asked().at(-1)!;
    expect(Date.now() - Date.parse(hour.get("from")!)).toBeGreaterThanOrEqual(3_600_000 - 5_000);
    expect(Date.now() - Date.parse(hour.get("from")!)).toBeLessThan(3_600_000 + 5_000);
  });

  it("Agent access lists each read with its token, outcome and reason, and pages back", async () => {
    const entry = (id: string, over: Record<string, unknown> = {}) => ({
      id,
      credential: { kind: "token", id: "t1", name: "Claude Desktop" },
      surface: "mcp",
      action: "get_presence",
      precise: false,
      outcome: "allowed",
      count: 1,
      createdAt: "2026-10-18T01:00:00.000Z",
      lastAt: "2026-10-18T01:00:00.000Z",
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
    route("GET /v1/activity/access?limit=50&before=cursor-1", () => ({
      status: 200,
      body: { entries: [entry("b", { action: "presence.read", surface: "rest", count: 7, lastAt: "2026-10-18T01:00:50.000Z" })] },
    }));
    await open("#activity");
    expect(host.textContent).toContain("Asked for your exact location");
    expect(host.textContent).toContain("Refused");
    expect(host.textContent).toContain("Reason given: pick me up");
    expect(host.textContent).toContain("Claude Desktop · MCP");

    await act(async () => button("Show older").click());
    await settle();
    expect(host.textContent).toContain("Read your status");
    expect(host.textContent).toContain("Claude Desktop · REST API");
    expect(host.textContent).toContain("×7");
    expect(host.textContent).toContain("Asked 7 times within a minute of each other");
    expect(() => button("Show older")).toThrow();
  });

  it("Agent access drops an older page that arrives after the token filter changed", async () => {
    const entry = (id: string, action: string) => ({
      id,
      credential: { kind: "token", id: "t1", name: "Claude Desktop" },
      surface: "rest",
      action,
      precise: false,
      outcome: "allowed",
      count: 1,
      createdAt: "2026-10-18T01:00:00.000Z",
      lastAt: "2026-10-18T01:00:00.000Z",
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    route("GET /v1/tokens", () => ({
      status: 200,
      body: { tokens: [{ id: "t1", name: "Claude Desktop", role: "agent", lastUsedAt: null }, { id: "t2", name: "Other bot", role: "agent", lastUsedAt: null }] },
    }));
    route("GET /v1/activity/access?limit=50", () => ({ status: 200, body: { entries: [entry("a", "presence.read")], next: "c1" } }));
    route("GET /v1/activity/access?limit=50&before=c1", async () => {
      await gate;
      return { status: 200, body: { entries: [entry("stale", "presence.history")] } };
    });
    route("GET /v1/activity/access?limit=50&credential=t2", () => ({ status: 200, body: { entries: [entry("b", "places.list")] } }));
    await open("#activity");
    await act(async () => button("Show older").click());
    await act(async () => (host.querySelector('[role="combobox"]') as HTMLElement).click());
    await settle();
    const option = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes("Other bot")) as HTMLElement;
    await act(async () => option.click());
    await settle();
    expect(host.textContent).toContain("Listed your places");
    release();
    await settle();
    expect(host.textContent).toContain("Listed your places");
    expect(host.textContent).not.toContain("Read your location history");
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

  it("Server logs is the operator's alone", async () => {
    route("GET /v1/admin/logs?level=info&limit=200", () => ({
      status: 200,
      body: { entries: [{ level: "warn", time: "2026-10-18T01:00:00.000Z", msg: "owntracks ingest rejected", fields: { error: "bad" } }] },
    }));
    route("GET /v1/privacy", () => ({ status: 200, body: { settings: { sharingPaused: false } } }));
    route("GET /v1/presence", () => ({ status: 404, body: {} }));
    route("GET /v1/people", () => ({ status: 200, body: { people: [] } }));

    await open("#logs");
    expect(host.querySelector("h1")?.textContent).toBe("Home");
    expect(host.querySelector('a[href="#logs"]')).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);

    route("GET /v1/me", () => ({ status: 200, body: { ...ME, isOperator: true } }));
    await act(async () => root.render(<App />));
    await settle();
    expect(host.querySelector("h1")?.textContent).toBe("Server logs");
    expect(host.querySelector('a[href="#logs"]')).not.toBeNull();
    expect(host.textContent).toContain("owntracks ingest rejected");
    expect(host.textContent).toContain("error=bad");
  });

  it("Webhooks starts with arrivals and departures, explains each event, and edits a hook's events", async () => {
    const hooks = [{ id: "h1", url: "https://ha.example/hook", events: ["*"], active: true }];
    let created: any;
    let patched: any;
    route("GET /v1/webhooks", () => ({ status: 200, body: { webhooks: hooks } }));
    route("GET /v1/webhooks/dead-letters?limit=20", () => ({ status: 200, body: { deadLetters: [] } }));
    route("POST /v1/webhooks", (body) => {
      created = body;
      return { status: 201, body: { webhook: { id: "h2" } } };
    });
    route("PATCH /v1/webhooks/h1", (body) => {
      patched = body;
      return { status: 200, body: { webhook: hooks[0] } };
    });
    await open("#webhooks");
    expect(host.textContent).toContain("Home Assistant");
    expect(host.textContent).toContain("Arrived at a place");
    expect(host.textContent).toContain("When you leave one of your places");
    const checked = () =>
      [...host.querySelectorAll<HTMLInputElement>('li input[type="checkbox"]')].filter((c) => c.checked).map((c) => c.closest("li")?.textContent ?? "");
    const on = checked();
    expect(on).toHaveLength(2);
    expect(on[0]).toContain("presence.entered_place");
    expect(on[1]).toContain("presence.left_place");
    const example = [...host.querySelectorAll("pre, code")].map((n) => n.textContent).join("\n");
    expect(example).toContain('"event": "presence.entered_place"');
    expect(example).not.toMatch(/"lat"|"lon"/);

    const input = host.querySelector<HTMLInputElement>('input[placeholder="https://…"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "https://n8n.example/hook");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Add").click());
    await settle();
    expect(created).toEqual({ url: "https://n8n.example/hook", events: ["presence.entered_place", "presence.left_place"] });

    await act(async () => button("Change events").click());
    await settle();
    const updated = [...host.querySelectorAll("li")].find((li) => li.textContent?.startsWith("Every location update"))!;
    await act(async () => updated.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => button("Save").click());
    await settle();
    expect(patched).toEqual({ events: ["presence.updated"] });
  });

  it("Devices shows the Shortcut's Authorization header as a name and a Bearer value", async () => {
    route("GET /v1/devices", () => ({ status: 200, body: { devices: [] } }));
    route("GET /v1/activity/ingest?limit=20", () => ({ status: 200, body: { entries: [] } }));
    route("POST /v1/devices/pair", () => ({
      status: 201,
      body: { kind: "shortcut", url: "https://where.example/v1/ingest/shortcut", token: "wctx_tok", headers: { Authorization: "Bearer wctx_tok" } },
    }));
    await open("#devices");
    const name = host.querySelector<HTMLInputElement>('input[placeholder="e.g. My iPhone"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "iPhone");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const shortcut = [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((r) => r.value === "shortcut")!;
    await act(async () => shortcut.click());
    await act(async () => button("Create connection").click());
    await settle();
    const block = host.querySelector('[data-testid="bearer-header"]')!;
    const codes = [...block.querySelectorAll("pre, code")].map((c) => c.textContent?.trim()).filter(Boolean);
    expect(codes).toContain("Authorization");
    const values = [...block.querySelectorAll("code")].map((c) => c.textContent?.trim() ?? "").filter((c) => c.includes("wctx_tok"));
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(value.startsWith("Bearer ")).toBe(true);
    expect(block.textContent).toContain("Header name");
    expect(block.textContent).toContain("Header value");
    expect(block.textContent).toContain("Get Contents of URL");
  });
});
