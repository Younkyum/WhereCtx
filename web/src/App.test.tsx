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

function buttonIn(scope: ParentNode, name: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
  if (!found) throw new Error(`no button "${name}"`);
  return found;
}

function inputLabelled(scope: ParentNode, label: string): HTMLInputElement {
  const target = [...scope.querySelectorAll("label")].find((l) => l.textContent?.trim().startsWith(label));
  const input = target?.htmlFor ? (scope.querySelector(`#${CSS.escape(target.htmlFor)}`) as HTMLInputElement | null) : null;
  if (!input) throw new Error(`no input labelled "${label}"`);
  return input;
}

async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function openDialog(): HTMLDialogElement | undefined {
  return [...host.querySelectorAll("dialog")].find((d) => d.open);
}

function dialogButton(name: string): HTMLButtonElement {
  const dialog = openDialog();
  if (!dialog) throw new Error(`no open dialog in: ${host.textContent}`);
  const found = [...dialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
  if (!found) throw new Error(`no button "${name}" in the dialog: ${dialog.textContent}`);
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

  it("shows how long ago, never a stale badge, and 'device offline' only when the device is offline", async () => {
    route("GET /v1/me", () => ({ status: 200, body: ME }));
    route("GET /v1/privacy", () => ({ status: 200, body: { settings: { sharingPaused: false } } }));
    route("GET /v1/presence", () => ({
      status: 200,
      body: { status: "home", label: "home", motion: "stationary", updatedAgoSec: 12 * 60, stale: false, freshness: "stationary", privacy: "coarse" },
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
    expect(host.textContent!.match(/device offline/g)).toHaveLength(1);
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
    // The point links, not the nav's "Maps & routes".
    const links = [...host.querySelectorAll("a")].filter((a) => a.textContent?.includes("Map") && a.getAttribute("href")?.startsWith("https:"));
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

  it("Webhooks adds a hook in a dialog, starting with arrivals and departures and an optional auth header", async () => {
    let created: any;
    route("GET /v1/webhooks", () => ({ status: 200, body: { webhooks: [], capabilities: { authHeader: true, authHeaderRequiresHttps: true } } }));
    route("GET /v1/webhooks/dead-letters?limit=20", () => ({ status: 200, body: { deadLetters: [] } }));
    route("POST /v1/webhooks", (body) => {
      created = body;
      return { status: 201, body: { webhook: { id: "h2" } } };
    });
    await open("#webhooks");
    expect(host.textContent).toContain("Home Assistant");
    expect(host.querySelector('input[placeholder="https://…"]')).toBeNull();

    await act(async () => button("Add webhook").click());
    await settle();
    const dialog = () => document.querySelector("dialog")!;
    expect(dialog().textContent).toContain("Arrived at a place");
    expect(dialog().textContent).toContain("When you leave one of your places");
    expect(dialog().textContent).toContain("signing secret");
    const checked = [...dialog().querySelectorAll<HTMLInputElement>('li input[type="checkbox"]')]
      .filter((c) => c.checked)
      .map((c) => c.closest("li")?.textContent ?? "");
    expect(checked).toHaveLength(2);
    expect(checked[0]).toContain("presence.entered_place");
    expect(checked[1]).toContain("presence.left_place");
    const example = () => [...dialog().querySelectorAll("pre, code")].map((n) => n.textContent).join("\n");
    expect(example()).toContain('"event": "presence.entered_place"');
    expect(example()).not.toMatch(/"lat"|"lon"|Authorization/);

    await fill(dialog().querySelector<HTMLInputElement>('input[placeholder="https://…"]')!, "https://n8n.example/hook");
    const nameInput = inputLabelled(dialog(), "Header name");
    expect(nameInput.value).toBe("Authorization");
    await fill(inputLabelled(dialog(), "Header value"), "Bearer n8n-header-credential-9f3k");
    const valueInput = inputLabelled(dialog(), "Header value");
    expect(valueInput.type).toBe("password");
    expect(valueInput.getAttribute("autocomplete")).toBe("new-password");
    expect(valueInput.hasAttribute("data-1p-ignore")).toBe(true);
    expect(valueInput.getAttribute("data-lpignore")).toBe("true");
    expect(dialog().textContent).toContain("The value is stored encrypted");
    expect(example()).toContain("Authorization: ••••••••9f3k");
    expect(example()).not.toContain("credential");

    await fill(nameInput, "X-WhereCtx-Signature");
    expect(dialog().textContent).toContain("an X- name ending in -Token");
    expect(buttonIn(dialog(), "Add").disabled).toBe(true);
    await fill(nameInput, "Authorization");

    await fill(dialog().querySelector<HTMLInputElement>('input[placeholder="https://…"]')!, "http://n8n.example/hook");
    expect(dialog().textContent).toContain("only to an https URL");
    expect(buttonIn(dialog(), "Add").disabled).toBe(true);
    await fill(dialog().querySelector<HTMLInputElement>('input[placeholder="https://…"]')!, "https://n8n.example/hook");
    expect(dialog().textContent).not.toContain("only to an https URL");

    await act(async () => buttonIn(dialog(), "Add").click());
    await settle();
    expect(created).toEqual({
      url: "https://n8n.example/hook",
      events: ["presence.entered_place", "presence.left_place"],
      authHeader: { name: "Authorization", value: "Bearer n8n-header-credential-9f3k" },
    });
    expect(document.querySelector("dialog[open]")).toBeNull();
  });

  it("Webhooks edits a hook in a dialog: events, and replacing or removing its auth header", async () => {
    const hooks = [{ id: "h1", url: "https://ha.example/hook", events: ["*"], active: true, authHeader: { name: "Authorization", hint: "…9f3k" } }];
    const patched: any[] = [];
    route("GET /v1/webhooks", () => ({ status: 200, body: { webhooks: hooks, capabilities: { authHeader: true, authHeaderRequiresHttps: true } } }));
    route("GET /v1/webhooks/dead-letters?limit=20", () => ({ status: 200, body: { deadLetters: [] } }));
    route("PATCH /v1/webhooks/h1", (body) => {
      patched.push(body);
      return { status: 200, body: { webhook: hooks[0] } };
    });
    await open("#webhooks");
    expect(host.textContent).toContain("Authorization …9f3k");

    await act(async () => button("Edit").click());
    await settle();
    const dialog = () => document.querySelector("dialog")!;
    expect(dialog().textContent).toContain("Sends Authorization with a value ending …9f3k.");
    const updated = [...dialog().querySelectorAll("li")].find((li) => li.textContent?.startsWith("Every location update"))!;
    await act(async () => updated.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => buttonIn(dialog(), "Remove").click());
    expect(dialog().textContent).toContain("removed when you save");
    await act(async () => buttonIn(dialog(), "Save").click());
    await settle();
    expect(patched.at(-1)).toEqual({ events: ["presence.updated"], authHeader: null });

    await act(async () => button("Edit").click());
    await settle();
    await act(async () => buttonIn(dialog(), "Replace").click());
    expect(buttonIn(dialog(), "Save").disabled).toBe(true);
    await fill(inputLabelled(dialog(), "Header name"), "X-Api-Key");
    await fill(inputLabelled(dialog(), "Header value"), "replacement-key-0042");
    await act(async () => buttonIn(dialog(), "Save").click());
    await settle();
    expect(patched.at(-1)).toEqual({ authHeader: { name: "X-Api-Key", value: "replacement-key-0042" } });
    expect(openDialog()).toBeUndefined();
  });

  it("Webhooks explains, and offers no auth header fields, when the server cannot encrypt one", async () => {
    route("GET /v1/webhooks", () => ({ status: 200, body: { webhooks: [], capabilities: { authHeader: false, authHeaderRequiresHttps: true } } }));
    route("GET /v1/webhooks/dead-letters?limit=20", () => ({ status: 200, body: { deadLetters: [] } }));
    await open("#webhooks");
    await act(async () => button("Add webhook").click());
    await settle();
    const dialog = document.querySelector("dialog")!;
    expect(dialog.textContent).toContain("WEBHOOK_ENCRYPTION_KEY is not set");
    expect(dialog.textContent).not.toContain("The value is stored encrypted");
    expect([...dialog.querySelectorAll("label")].map((l) => l.textContent)).not.toContain("Header value");
  });

  it("Webhooks marks a hook whose credentials are unreadable and offers to replace or delete it", async () => {
    const hooks = [{ id: "h1", url: "https://ha.example/hook", events: ["*"], active: true, credentialsUnreadable: true }];
    const patched: any[] = [];
    route("GET /v1/webhooks", () => ({ status: 200, body: { webhooks: hooks, capabilities: { authHeader: true, authHeaderRequiresHttps: true } } }));
    route("GET /v1/webhooks/dead-letters?limit=20", () => ({ status: 200, body: { deadLetters: [] } }));
    route("PATCH /v1/webhooks/h1", (body) => {
      patched.push(body);
      return { status: 200, body: { webhook: hooks[0] } };
    });
    await open("#webhooks");
    expect(host.textContent).toContain("Credentials unreadable: replace or delete");
    expect(button("Delete")).toBeDefined();

    await act(async () => button("Edit").click());
    await settle();
    const dialog = () => document.querySelector("dialog")!;
    expect(dialog().textContent).toContain("nothing is delivered to it");
    await act(async () => buttonIn(dialog(), "Replace").click());
    await fill(inputLabelled(dialog(), "Header value"), "Bearer replacement-credential-00042");
    await act(async () => buttonIn(dialog(), "Save").click());
    await settle();
    expect(patched.at(-1)).toEqual({ authHeader: { name: "Authorization", value: "Bearer replacement-credential-00042" } });
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
    expect(openDialog()).toBeUndefined();
    expect(host.querySelector('input[placeholder="https://…"]')).toBeNull();

    await act(async () => button("Add webhook").click());
    await settle();
    const dialog = openDialog()!;
    expect(dialog.textContent).toContain("Arrived at a place");
    expect(dialog.textContent).toContain("When you leave one of your places");
    const checked = () =>
      [...dialog.querySelectorAll<HTMLInputElement>('li input[type="checkbox"]')].filter((c) => c.checked).map((c) => c.closest("li")?.textContent ?? "");
    const on = checked();
    expect(on).toHaveLength(2);
    expect(on[0]).toContain("presence.entered_place");
    expect(on[1]).toContain("presence.left_place");
    const example = [...dialog.querySelectorAll("pre, code")].map((n) => n.textContent).join("\n");
    expect(example).toContain('"event": "presence.entered_place"');
    expect(example).not.toMatch(/"lat"|"lon"/);

    const input = dialog.querySelector<HTMLInputElement>('input[placeholder="https://…"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "https://n8n.example/hook");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => dialogButton("Add").click());
    await settle();
    expect(created).toEqual({ url: "https://n8n.example/hook", events: ["presence.entered_place", "presence.left_place"] });
    expect(openDialog()).toBeUndefined();

    await act(async () => button("Edit").click());
    await settle();
    const updated = [...openDialog()!.querySelectorAll("li")].find((li) => li.textContent?.startsWith("Every location update"))!;
    await act(async () => updated.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => dialogButton("Save").click());
    await settle();
    expect(patched).toEqual({ events: ["presence.updated"] });
    expect(openDialog()).toBeUndefined();
  });


  it("Devices shows the Shortcut's Authorization header as a name and a Bearer value", async () => {
    route("GET /v1/devices", () => ({ status: 200, body: { devices: [] } }));
    route("GET /v1/activity/ingest?limit=20", () => ({ status: 200, body: { entries: [] } }));
    route("POST /v1/devices/pair", () => ({
      status: 201,
      body: { kind: "shortcut", url: "https://where.example/v1/ingest/shortcut", token: "wctx_tok", headers: { Authorization: "Bearer wctx_tok" } },
    }));
    await open("#devices");
    expect(host.querySelector('input[placeholder="e.g. My iPhone"]')).toBeNull();
    await act(async () => button("Connect a phone").click());
    await settle();
    const name = openDialog()!.querySelector<HTMLInputElement>('input[placeholder="e.g. My iPhone"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "iPhone");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const shortcut = [...openDialog()!.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((r) => r.value === "shortcut")!;
    await act(async () => shortcut.click());
    await act(async () => dialogButton("Create connection").click());
    await settle();
    expect(openDialog()!.textContent).toContain("Set up iPhone");
    const block = openDialog()!.querySelector('[data-testid="bearer-header"]')!;
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

describe("maps", () => {
  async function fill(input: HTMLInputElement, value: string) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  const inputLabelled = (label: string) => {
    const l = [...host.querySelectorAll("label")].find((x) => x.textContent?.trim() === label);
    const input = (l?.htmlFor && document.getElementById(l.htmlFor)) || l?.parentElement?.querySelector("input");
    if (!input) throw new Error(`no input "${label}"`);
    return input as HTMLInputElement;
  };

  afterEach(() => {
    location.hash = "";
  });

  it("shows a saved key only by its hint, saves a new one write-only, and turns maps on", async () => {
    const bodies: unknown[] = [];
    route("GET /v1/me", () => ({ status: 200, body: ME }));
    route("GET /v1/geo", () => ({
      status: 200,
      body: {
        active: { provider: "kakao", source: "own" },
        credentials: [{ provider: "kakao", status: "ok", kinds: { restKey: "cdef" }, updatedAt: "2026-10-19T00:00:00Z", lastUsedAt: null, lastError: null }],
        operator: [],
      },
    }));
    route("GET /v1/privacy", () => ({ status: 200, body: { settings: { geoEnabled: false, skipProviderNearHome: true, geoProvider: null } } }));
    route("PUT /v1/privacy", (b) => (bodies.push(b), { status: 200, body: { settings: {} } }));
    route("PUT /v1/geo/credentials/naver", (b) => (bodies.push(b), { status: 200, body: { credential: {} } }));
    location.hash = "#maps";
    await act(async () => root.render(<App />));
    await settle();
    expect(host.textContent).toContain("Saved key ••••cdef");
    expect(host.textContent).toContain("Routes and addresses go to Kakao with your key.");

    expect(host.querySelector('input[type="password"]')).toBeNull();
    const add = [...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Add key");
    await act(async () => add[0]!.click());
    await settle();
    expect(openDialog()?.textContent).toContain("Add your Naver key");
    await fill(inputLabelled("Client ID"), "naver-client-id-1234");
    await fill(inputLabelled("Client Secret"), "naver-client-secret-5678");
    await act(async () => button("Save key").click());
    await settle();
    expect(bodies).toContainEqual({ clientId: "naver-client-id-1234", clientSecret: "naver-client-secret-5678" });
    expect(host.textContent).not.toContain("naver-client-secret-5678");

    const toggle = inputLabelled("Use maps with my location");
    await act(async () => toggle.click());
    await settle();
    expect(bodies).toContainEqual({ geoEnabled: true });
  });

  it("says what the provider refused when a key test fails, what to fix, and the provider's own words", async () => {
    route("GET /v1/me", () => ({ status: 200, body: ME }));
    route("GET /v1/geo", () => ({
      status: 200,
      body: {
        active: { provider: "kakao", source: "own" },
        credentials: [{ provider: "kakao", status: "ok", kinds: { restKey: "cdef" }, updatedAt: "2026-10-19T00:00:00Z", lastUsedAt: null, lastError: null }],
        operator: [],
      },
    }));
    route("GET /v1/privacy", () => ({ status: 200, body: { settings: { geoEnabled: true, geoProvider: null } } }));
    route("POST /v1/geo/credentials/kakao/test", () => ({
      status: 200,
      body: {
        test: {
          ok: false,
          error: "auth",
          message: "Kakao Map is turned off for this app",
          api: "geocoding",
          code: "map_service_disabled",
          providerMessage: "App(WhereCtx) disabled OPEN_MAP_AND_LOCAL service.",
        },
      },
    }));
    location.hash = "#maps";
    await act(async () => root.render(<App />));
    await settle();
    await act(async () => button("Test").click());
    await settle();
    expect(host.textContent).toContain("Kakao turned down the address lookup.");
    expect(host.textContent).toContain("제품 설정, 카카오맵, set 사용 설정 to ON");
    expect(host.textContent).toContain("Kakao said: \u201cApp(WhereCtx) disabled OPEN_MAP_AND_LOCAL service.\u201d");
  });

  it("asks for the drive time home only when the button is pressed", async () => {
    route("GET /v1/me", () => ({ status: 200, body: ME }));
    route("GET /v1/privacy", () => ({ status: 200, body: { settings: { sharingPaused: false, geoEnabled: true } } }));
    route("GET /v1/presence", () => ({
      status: 200,
      body: { status: "away", label: "away", motion: "unknown", updatedAgoSec: 60, stale: false, freshness: "live", privacy: "coarse" },
    }));
    route("GET /v1/people", () => ({ status: 200, body: { people: [] } }));
    route("GET /v1/places", () => ({ status: 200, body: { places: [{ name: "집", type: "home", lat: 37.5, lon: 127, radiusM: 150 }] } }));
    route("GET /v1/geo/eta", () => ({
      status: 200,
      body: { eta: { destination: { label: "집", kind: "place" }, origin: "current_location", precision: "exact", durationMin: 23, distanceKm: 9.1, traffic: "live", arriveAt: "2026-10-19T09:00:00Z", summary: [], provider: "kakao" } },
    }));
    await act(async () => root.render(<App />));
    await settle();
    expect(calls.filter((c) => c.startsWith("GET /v1/geo/eta"))).toEqual([]);
    await act(async () => button("Check time to home").click());
    await settle();
    expect(calls.filter((c) => c.startsWith("GET /v1/geo/eta"))).toEqual(["GET /v1/geo/eta?to=%EC%A7%91"]);
    expect(host.textContent).toContain("To home: 23 min (live traffic)");
  });

  it("adds a place by address: search, pick, save with the picked point", async () => {
    let posted: any;
    route("GET /v1/me", () => ({ status: 200, body: ME }));
    route("GET /v1/places", () => ({ status: 200, body: { places: [] } }));
    route("GET /v1/geo/search", () => ({
      status: 200,
      body: {
        provider: "kakao",
        candidates: [
          { label: "판교역 신분당선", address: "경기 성남시 분당구 백현동 534", lat: 37.3948, lon: 127.1112, kind: "place" },
          { label: "판교역 경강선", address: "경기 성남시 분당구 백현동 535", lat: 37.3951, lon: 127.1109, kind: "place" },
        ],
      },
    }));
    route("POST /v1/places", (b) => ((posted = b), { status: 201, body: { place: b } }));
    location.hash = "#places";
    await act(async () => root.render(<App />));
    await settle();
    expect(host.querySelector("input")).toBeNull();
    await act(async () => button("Add by address or name").click());
    await settle();
    expect(openDialog()?.textContent).toContain("Add by address or name");
    await fill(inputLabelled("Address or place name"), "판교역");
    await act(async () => button("Search").click());
    await settle();
    expect(calls).toContain(`GET /v1/geo/search?q=${encodeURIComponent("판교역")}`);
    const map = [...host.querySelectorAll("a")].find((a) => a.textContent?.includes("View on map"))!;
    expect(map.getAttribute("href")).toBe(`https://map.kakao.com/link/map/${encodeURIComponent("판교역 신분당선")},37.3948,127.1112`);
    const use = [...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Use this");
    await act(async () => use[1]!.click());
    await settle();
    await act(async () => button("Save place").click());
    await settle();
    expect(posted).toMatchObject({ name: "판교역 경강선", type: "custom", lat: 37.3951, lon: 127.1109 });
    expect(openDialog()).toBeUndefined();
  });
});

describe("place rules and webhook places", () => {
  const OFFICE = [
    [127.012345, 37.567891],
    [127.014567, 37.567891],
    [127.014567, 37.569123],
    [127.012345, 37.567891],
  ];
  const OFFICE_PLACE = {
    name: "office",
    type: "work",
    lat: 37.5685,
    lon: 127.0134,
    radiusM: 120,
    polygon: OFFICE,
    enterAfterSec: 0,
    exitAfterSec: 0,
    approachM: null,
    emits: ["presence.entered_place", "presence.left_place", "presence.approaching_place"],
    notifyWebhooks: true,
    notifyReminders: true,
  };
  const GYM = { name: "gym", type: "custom", lat: 37.1, lon: 127, radiusM: 80 };

  async function open(hash: string) {
    route("GET /v1/me", () => ({ status: 200, body: ME }));
    location.hash = hash;
    await act(async () => root.render(<App />));
    await settle();
  }

  async function fill(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
  }

  const inputLabelled = (label: string) => {
    const l = [...host.querySelectorAll("label")].find((x) => x.textContent?.trim().startsWith(label));
    const input = (l?.htmlFor && document.getElementById(l.htmlFor)) || l?.parentElement?.querySelector("input");
    if (!input) throw new Error(`no input "${label}"`);
    return input as HTMLInputElement;
  };

  const vertices = () => openDialog()!.querySelector("textarea")!;

  async function click(target: HTMLElement) {
    await act(async () => target.click());
    await settle();
  }

  function servePlaces(places: unknown[]) {
    const posted: any[] = [];
    route("GET /v1/places", () => ({ status: 200, body: { places } }));
    route("POST /v1/places", (b) => (posted.push(b), { status: 201, body: { place: b } }));
    return posted;
  }

  afterEach(() => {
    location.hash = "";
  });

  it("lists each place's rules read-only and edits them in a dialog that keeps a polygon's outline", async () => {
    const posted = servePlaces([OFFICE_PLACE]);
    await open("#places");
    expect(host.textContent).toContain("Place rules");
    expect(host.textContent).toContain("Polygon");
    expect(host.textContent).toContain("Arrival after 0 min, departure after 0 min");
    expect(host.textContent).not.toContain("Count an arrival after");
    expect(openDialog()).toBeUndefined();

    await click(button("Edit rules"));
    expect(openDialog()!.textContent).toContain("Rules for office");
    expect(openDialog()!.textContent).toContain("Other events still carry your status");
    expect(vertices().value).toBe("37.567891, 127.012345\n37.567891, 127.014567\n37.569123, 127.014567");
    await fill(inputLabelled("Count an arrival after"), "5");
    await click(dialogButton("Save"));
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ name: "office", type: "work", polygon: OFFICE, enterAfterSec: 300, exitAfterSec: 0, approachM: null });
    expect(posted[0]).not.toHaveProperty("lat");
    expect(openDialog()).toBeUndefined();
  });

  it("posts nothing on Cancel and opens with the saved values again", async () => {
    const posted = servePlaces([GYM]);
    await open("#places");
    await click(button("Edit rules"));
    await fill(inputLabelled("Count an arrival after"), "5");
    await click(dialogButton("Cancel"));
    expect(openDialog()).toBeUndefined();
    expect(posted).toEqual([]);

    await click(button("Edit rules"));
    expect(inputLabelled("Count an arrival after").value).toBe("0");
  });

  it("turns typed lat, lon lines into a closed [lon, lat] ring and names the line that is not a point", async () => {
    const posted = servePlaces([GYM]);
    await open("#places");
    await click(button("Edit rules"));
    await click(dialogButton("Polygon"));
    await fill(vertices(), "37.5, 127.0\n37.5 127.001\nnot a point");
    expect(openDialog()!.textContent).toContain(`Line 3 isn't a "lat, lon" point.`);
    expect(dialogButton("Save").disabled).toBe(true);

    await fill(vertices(), "37.5, 127.0\n\n37.5, 127.001\n37.501, 127.001\n");
    expect(openDialog()!.textContent).not.toContain("isn't a");
    await click(dialogButton("Save"));
    expect(posted).toHaveLength(1);
    expect(posted[0].polygon).toEqual([
      [127, 37.5],
      [127.001, 37.5],
      [127.001, 37.501],
      [127, 37.5],
    ]);
    expect(posted[0]).not.toHaveProperty("lat");
    expect(posted[0]).not.toHaveProperty("radiusM");
  });

  it("turns a polygon place into a circle around its centroid", async () => {
    const posted = servePlaces([OFFICE_PLACE]);
    await open("#places");
    await click(button("Edit rules"));
    await click(dialogButton("Circle"));
    expect(inputLabelled("Latitude").value).toBe("37.5685");
    await click(dialogButton("Save"));
    expect(posted[0]).toMatchObject({ name: "office", lat: 37.5685, lon: 127.0134, radiusM: 120 });
    expect(posted[0]).not.toHaveProperty("polygon");
  });

  it("keeps the dialog open with the server's reason when a save fails", async () => {
    route("GET /v1/places", () => ({ status: 200, body: { places: [OFFICE_PLACE] } }));
    route("POST /v1/places", () => ({ status: 400, body: { error: "invalid place", detail: ["polygon: polygon edges must not cross or touch"] } }));
    await open("#places");
    await click(button("Edit rules"));
    await click(dialogButton("Save"));
    expect(openDialog()!.textContent).toContain("polygon: polygon edges must not cross or touch");
    expect(dialogButton("Save").disabled).toBe(false);
  });

  it("titles a refused save in the page's language and shows the server's words below", async () => {
    Object.defineProperty(navigator, "language", { configurable: true, value: "ko-KR" });
    try {
      route("GET /v1/places", () => ({ status: 200, body: { places: [GYM] } }));
      route("POST /v1/places", () => ({ status: 409, body: { error: "place limit reached (100)" } }));
      await open("#places");
      await click(button("규칙 편집"));
      await click(dialogButton("저장"));
      expect(openDialog()!.textContent).toContain("문제가 생겼어요. 다시 시도해 주세요.");
      expect(openDialog()!.textContent).toContain("place limit reached (100)");
    } finally {
      delete (navigator as { language?: string }).language;
    }
  });

  const NYC = { name: "nyc", type: "custom", lat: 40.7, lon: -74.0, radiusM: 100 };

  it("reads a typed outline's centre back and warns, without blocking, when it lands far from the place", async () => {
    const posted = servePlaces([NYC]);
    await open("#places");
    await click(button("Edit rules"));
    await click(dialogButton("Polygon"));
    await fill(vertices(), "40.70, -74.00\n40.71, -74.00\n40.71, -74.01");
    expect(openDialog()!.textContent).toContain("Centre ≈ lat 40.7067, lon -74.0033");
    expect(openDialog()!.textContent).not.toContain("swap");

    await fill(vertices(), "-74.00, 40.70\n-74.00, 40.71\n-74.01, 40.71");
    expect(openDialog()!.textContent).toContain("Centre ≈ lat -74.0033, lon 40.7067");
    expect(openDialog()!.textContent).toMatch(/about [\d,]+ km from where the place is now\. If you typed "lon, lat", swap/);
    expect(dialogButton("Save").disabled).toBe(false);
    await click(dialogButton("Save"));
    expect(posted).toHaveLength(1);
  });

  it("says why Save is off: a repeated point names its line, an empty polygon asks for 3 points", async () => {
    servePlaces([GYM]);
    await open("#places");
    await click(button("Edit rules"));
    await click(dialogButton("Polygon"));
    expect(vertices().value).toBe("");
    expect(openDialog()!.textContent).toContain("Enter at least 3 points.");
    expect(dialogButton("Save").disabled).toBe(true);

    await fill(vertices(), "37.5, 127.0\n37.5, 127.0\n37.501, 127.001");
    expect(openDialog()!.textContent).toContain("Line 2 repeats the point before it.");
    expect(dialogButton("Save").disabled).toBe(true);
  });

  async function pressEscape() {
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await settle();
  }

  it("discards the draft on Escape", async () => {
    const posted = servePlaces([GYM]);
    await open("#places");
    await click(button("Edit rules"));
    await fill(inputLabelled("Count an arrival after"), "5");
    await pressEscape();
    expect(openDialog()).toBeUndefined();
    expect(posted).toEqual([]);

    await click(button("Edit rules"));
    expect(inputLabelled("Count an arrival after").value).toBe("0");
  });

  it("stays open while a save is in flight, whatever asks it to close, and closes once it lands", async () => {
    let land!: () => void;
    const posted: unknown[] = [];
    route("GET /v1/places", () => ({ status: 200, body: { places: [GYM] } }));
    route("POST /v1/places", (b) => {
      posted.push(b);
      return new Promise<Reply>((resolve) => (land = () => resolve({ status: 201, body: { place: b } })));
    });
    const reloads = () => calls.filter((c) => c === "GET /v1/places").length;
    await open("#places");
    await click(button("Edit rules"));
    const before = reloads();
    await click(dialogButton("Save"));
    expect(posted).toHaveLength(1);

    expect(dialogButton("Cancel").disabled).toBe(true);
    await click(dialogButton("Cancel"));
    await pressEscape();
    await click(openDialog()!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!);
    expect(openDialog()!.textContent).toContain("Rules for gym");
    expect(reloads()).toBe(before);

    await act(async () => land());
    await settle();
    expect(openDialog()).toBeUndefined();
    expect(reloads()).toBe(before + 1);
    expect(posted).toHaveLength(1);
  });

  const placeItem = (name: string) =>
    [...openDialog()!.querySelectorAll("li")].find((li) => li.textContent?.startsWith(name))!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

  function serveHooks(places: unknown[], hooks: unknown[] = []) {
    route("GET /v1/webhooks", () => ({ status: 200, body: { webhooks: hooks } }));
    route("GET /v1/webhooks/dead-letters?limit=20", () => ({ status: 200, body: { deadLetters: [] } }));
    route("GET /v1/places", () => ({ status: 200, body: { places } }));
  }

  it("creates a webhook for chosen places only", async () => {
    let created: any;
    serveHooks([{ name: "home", type: "home", lat: 37, lon: 127, radiusM: 150 }, GYM]);
    route("POST /v1/webhooks", (body) => ((created = body), { status: 201, body: { webhook: { id: "h2" } } }));
    await open("#webhooks");
    await click(button("Add webhook"));
    expect(openDialog()!.textContent).toContain("All places");
    await click(placeItem("gym"));
    await fill(openDialog()!.querySelector<HTMLInputElement>('input[placeholder="https://…"]')!, "https://n8n.example/hook");
    await click(dialogButton("Add"));
    expect(created).toEqual({ url: "https://n8n.example/hook", events: ["presence.entered_place", "presence.left_place"], places: ["gym"] });
    expect(openDialog()).toBeUndefined();
  });

  it("will not save a hook with no place picked, and says why", async () => {
    const hooks = [{ id: "h1", url: "https://ha.example/hook", events: ["*"], active: true }];
    let patched: any;
    serveHooks([GYM], hooks);
    route("PATCH /v1/webhooks/h1", (body) => ((patched = body), { status: 200, body: { webhook: hooks[0] } }));
    await open("#webhooks");
    await click(button("Add webhook"));
    await fill(openDialog()!.querySelector<HTMLInputElement>('input[placeholder="https://…"]')!, "https://n8n.example/hook");
    await click(placeItem("All places"));
    expect(dialogButton("Add").disabled).toBe(true);
    expect(openDialog()!.textContent).toContain("Pick at least one place, or All places.");
    await click(dialogButton("Cancel"));

    await click(button("Edit"));
    await click(placeItem("All places"));
    expect(dialogButton("Save").disabled).toBe(true);
    await click(dialogButton("Save"));
    expect(patched).toBeUndefined();
  });

  it("tells a place named * apart from all places", async () => {
    let created: any;
    serveHooks([{ name: "*", type: "custom", lat: 37, lon: 127, radiusM: 150 }, GYM]);
    route("POST /v1/webhooks", (body) => ((created = body), { status: 201, body: { webhook: { id: "h2" } } }));
    await open("#webhooks");
    await click(button("Add webhook"));
    await click(placeItem("*"));
    expect(placeItem("*").checked).toBe(true);
    expect(placeItem("gym").checked).toBe(false);
    await fill(openDialog()!.querySelector<HTMLInputElement>('input[placeholder="https://…"]')!, "https://n8n.example/hook");
    await click(dialogButton("Add"));
    expect(created).toEqual({ url: "https://n8n.example/hook", events: ["presence.entered_place", "presence.left_place"], places: ["*"] });
  });
});

describe("create and edit dialogs", () => {
  async function open(hash: string, me: unknown = ME) {
    route("GET /v1/me", () => ({ status: 200, body: me }));
    location.hash = hash;
    await act(async () => root.render(<App />));
    await settle();
  }

  async function click(target: HTMLElement) {
    await act(async () => target.click());
    await settle();
  }

  /** Enter in a field submits its form, as the browser does for a form with a submit button. */
  async function pressEnterIn(input: HTMLInputElement) {
    await act(async () => input.form!.requestSubmit());
    await settle();
  }

  async function pressEscape() {
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await settle();
  }

  async function choose(scope: ParentNode, option: string) {
    await click(scope.querySelector<HTMLElement>('[role="combobox"]')!);
    await click([...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.trim() === option)!);
  }

  const dialog = () => {
    const d = openDialog();
    if (!d) throw new Error(`no open dialog in: ${host.textContent}`);
    return d;
  };

  afterEach(() => {
    location.hash = "";
  });

  it("Agents creates a token in a dialog and shows its secret there once, then lists it", async () => {
    let tokens: unknown[] = [];
    let posted: unknown;
    route("GET /v1/tokens", () => ({ status: 200, body: { tokens } }));
    route("GET /v1/oauth/grants", () => ({ status: 200, body: { grants: [] } }));
    route("POST /v1/tokens", (b) => {
      posted = b;
      tokens = [{ id: "k1", name: "Claude Desktop", role: "agent", lastUsedAt: null }];
      return { status: 201, body: { secret: "wctx_agent_secret", mcpConfig: { mcpServers: {} } } };
    });
    await open("#agents");
    expect(host.querySelector("form")).toBeNull();

    await click(button("New agent token"));
    await fill(inputLabelled(dialog(), "Name"), "Claude Desktop");
    await pressEnterIn(inputLabelled(dialog(), "Name"));
    expect(posted).toEqual({ name: "Claude Desktop", role: "agent" });
    expect(dialog().textContent).toContain("wctx_agent_secret");
    expect(dialog().textContent).toContain("MCP config");
    expect(host.textContent).toContain("Claude Desktop");

    await click(dialogButton("Done"));
    expect(openDialog()).toBeUndefined();
    expect(host.textContent).not.toContain("wctx_agent_secret");
  });

  it("Devices pairs a phone in a dialog: the QR code shows there, and an unusable BASE_URL keeps the form open", async () => {
    let unusable = true;
    route("GET /v1/devices", () => ({ status: 200, body: { devices: [] } }));
    route("GET /v1/activity/ingest?limit=20", () => ({ status: 200, body: { entries: [] } }));
    route("POST /v1/devices/pair", () =>
      unusable
        ? { status: 400, body: { error: "BASE_URL is http://localhost", code: "base_url_unusable" } }
        : {
            status: 201,
            body: { kind: "owntracks", link: "owntracks:///config?inline=x", config: {}, qrSvg: '<svg viewBox="0 0 10 10"><path d="M0 0h1v1H0z"/></svg>' },
          },
    );
    await open("#devices");
    await click(button("Connect a phone"));
    await fill(inputLabelled(dialog(), "Device name"), "Pixel");
    await pressEnterIn(inputLabelled(dialog(), "Device name"));
    expect(dialog().textContent).toContain("Phones can't reach this server's address");
    expect(dialog().textContent).toContain("BASE_URL is http://localhost");
    expect(inputLabelled(dialog(), "Device name").value).toBe("Pixel");

    unusable = false;
    await click(dialogButton("Create connection"));
    expect(dialog().textContent).toContain("Set up Pixel");
    expect(dialog().querySelector('svg[role="img"]')).not.toBeNull();
    expect(calls.filter((c) => c === "GET /v1/devices").length).toBeGreaterThan(1);
    await click(dialogButton("Done"));
    expect(openDialog()).toBeUndefined();
  });

  function serveWorkspace() {
    const sent: Record<string, unknown[]> = { rename: [], role: [], invite: [], create: [] };
    let wsName = "Home";
    route("GET /v1/workspaces", () => ({ status: 200, body: { workspaces: [{ id: "w1", name: wsName, role: "owner" }] } }));
    route("GET /v1/workspaces/w1/members", () => ({
      status: 200,
      body: {
        members: [
          { userId: "u1", displayName: "Me", role: "owner", joinedAt: "2026-01-01T00:00:00.000Z" },
          { userId: "u2", displayName: "Kim", role: "member", joinedAt: "2026-01-02T00:00:00.000Z" },
        ],
      },
    }));
    route("GET /v1/workspaces/w1/invites", () => ({ status: 200, body: { invites: [] } }));
    route("PATCH /v1/workspaces/w1", (b: any) => (sent.rename!.push(b), (wsName = b.name), { status: 200, body: { ok: true } }));
    route("PATCH /v1/workspaces/w1/members/u2", (b) => (sent.role!.push(b), { status: 200, body: { ok: true } }));
    route("POST /v1/workspaces/w1/invites", (b) => (
      sent.invite!.push(b), { status: 201, body: { url: "https://where.example/invite/abc", expiresAt: "2026-10-26T00:00:00.000Z" } }
    ));
    route("POST /v1/workspaces", (b) => (sent.create!.push(b), { status: 403, body: { error: "forbidden", code: "forbidden" } }));
    return sent;
  }

  it("Workspace renames, changes a member's role, and invites in dialogs; nothing is edited on the page", async () => {
    const sent = serveWorkspace();
    await open("#workspace");
    expect(host.querySelector("form")).toBeNull();
    expect(host.textContent).toContain("Member");

    await click(button("Rename"));
    expect(dialogButton("Save").disabled).toBe(true);
    await fill(inputLabelled(dialog(), "Workspace name"), "Family");
    await pressEnterIn(inputLabelled(dialog(), "Workspace name"));
    expect(sent.rename).toEqual([{ name: "Family" }]);
    expect(openDialog()).toBeUndefined();
    expect(host.textContent).toContain("Family");

    await click(button("Change role"));
    expect(dialog().textContent).toContain("Change Kim's role");
    await choose(dialog(), "Admin");
    await click(dialogButton("Save"));
    expect(sent.role).toEqual([{ role: "admin" }]);
    expect(openDialog()).toBeUndefined();

    await click(button("Create invite link"));
    await click(dialogButton("Create invite link"));
    expect(sent.invite).toEqual([{ role: "member" }]);
    expect(dialog().textContent).toContain("https://where.example/invite/abc");
    await click(dialogButton("Done"));
    expect(openDialog()).toBeUndefined();
    expect(host.textContent).not.toContain("https://where.example/invite/abc");
  });

  it("Workspace says inside the dialog when this server lets only owners and admins create a workspace", async () => {
    const sent = serveWorkspace();
    await open("#workspace");
    await click(button("New workspace"));
    await fill(inputLabelled(dialog(), "Workspace name"), "Club");
    await click(dialogButton("Create"));
    expect(sent.create).toEqual([{ name: "Club" }]);
    expect(dialog().textContent).toContain("Only workspace owners and admins can create workspaces on this server.");
  });

  it("Account changes the display name in a dialog submitted with Enter", async () => {
    let me = { ...ME, user: { id: "u1", displayName: "Jin" } };
    const sent: unknown[] = [];
    route("PATCH /v1/me", (b: any) => (sent.push(b), (me = { ...me, user: { ...me.user, displayName: b.displayName } }), { status: 200, body: { ok: true } }));
    route("GET /v1/me", () => ({ status: 200, body: me }));
    location.hash = "#account";
    await act(async () => root.render(<App />));
    await settle();
    expect(host.querySelector("form")).toBeNull();
    await click(button("Change display name"));
    await fill(inputLabelled(dialog(), "Display name"), "Younkyum");
    await pressEnterIn(inputLabelled(dialog(), "Display name"));
    expect(sent).toEqual([{ displayName: "Younkyum" }]);
    expect(openDialog()).toBeUndefined();
    expect(host.textContent).toContain("Younkyum");
  });

  it("Account keeps a cancelled passkey prompt inside the Add a passkey dialog", async () => {
    route("POST /v1/me/passkeys/options", () => ({ status: 200, body: { ceremony: "c1", options: { challenge: "AQID", user: { id: "AQ" } } } }));
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: { create: vi.fn(async () => Promise.reject(Object.assign(new Error("cancelled"), { name: "NotAllowedError" }))) },
    });
    await open("#account");
    await click(button("Add a passkey"));
    await click(dialogButton("Create passkey"));
    expect(calls).not.toContain("POST /v1/me/passkeys/verify");
    expect(dialog().textContent).toMatch(/cancel/i);
    expect(dialogButton("Create passkey").disabled).toBe(false);
  });

  it("Account makes new recovery codes after a passkey step-up, and holds the dialog until they are saved", async () => {
    let reauthed = false;
    route("POST /v1/me/reauth/options", () => ({ status: 200, body: { ceremony: "c1", options: { challenge: "AQID" } } }));
    route("POST /v1/me/reauth/verify", () => ((reauthed = true), { status: 200, body: { ok: true } }));
    route("POST /v1/me/recovery-codes", () =>
      reauthed
        ? { status: 200, body: { recoveryCodes: ["aaaa-bbbb", "cccc-dddd"] } }
        : { status: 403, body: { error: "confirm with your passkey first", code: "reauth_required" } },
    );
    await open("#account");
    await click(button("Make new recovery codes"));
    expect(dialog().textContent).toContain("Your current codes stop working.");
    await click(dialogButton("Make new codes"));
    expect(calls).toContain("POST /v1/me/reauth/verify");
    expect(dialog().textContent).toContain("aaaa-bbbb");
    expect(dialog().querySelector('button[aria-label="Close"]')).toBeNull();
    dialog().querySelector<HTMLInputElement>('input[type="checkbox"]')!.focus();
    await pressEscape();
    expect(dialog().textContent).toContain("aaaa-bbbb");
    expect(dialogButton("Continue").disabled).toBe(true);
    await click(dialog().querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await click(dialogButton("Continue"));
    expect(openDialog()).toBeUndefined();
    expect(host.textContent).not.toContain("aaaa-bbbb");
  });

  it("Sharing edits what a person sees in a dialog and sends only what changed", async () => {
    let outgoing: any[] = [{ viewer: { id: "u2", displayName: "Kim" }, level: "coarse", hideHomeExact: true, showArea: false }];
    const sent: string[] = [];
    route("GET /v1/shares", () => ({ status: 200, body: { outgoing, incoming: [] } }));
    route("GET /v1/workspaces", () => ({ status: 200, body: { workspaces: [{ id: "w1", name: "Home" }] } }));
    route("GET /v1/workspaces/w1/members", () => ({
      status: 200,
      body: { members: [{ userId: "u1", displayName: "Me" }, { userId: "u2", displayName: "Kim" }, { userId: "u3", displayName: "Lee" }] },
    }));
    route("GET /v1/privacy", () => ({ status: 200, body: { settings: { sharingPaused: false, hideHomeExactCoordinates: true, areaToPeople: false } } }));
    route("GET /v1/shares/audit?limit=50", () => ({ status: 200, body: { audit: [] } }));
    route("PUT /v1/shares/u2", (b) => (sent.push(`PUT u2 ${JSON.stringify(b)}`), (outgoing = [{ ...outgoing[0], ...(b as object) }]), { status: 200, body: {} }));
    route("PUT /v1/shares/u3", (b) => (sent.push(`PUT u3 ${JSON.stringify(b)}`), { status: 200, body: {} }));
    route("DELETE /v1/shares/u2", () => (sent.push("DELETE u2"), (outgoing = []), { status: 200, body: { ok: true } }));
    await open("#sharing");
    expect(host.querySelector('[role="combobox"]')).toBeNull();
    expect(host.textContent).toContain("Status only");

    await click(button("Edit"));
    expect(dialog().textContent).toContain("Sharing with Kim");
    expect(dialogButton("Save").disabled).toBe(true);
    await choose(dialog(), "Exact location");
    expect(dialog().textContent).toContain("Hide my exact location at home");
    await click(dialogButton("Save"));
    expect(sent).toEqual(['PUT u2 {"level":"precise"}']);
    expect(openDialog()).toBeUndefined();
    expect(host.textContent).toContain("Exact location (hidden at home)");

    const lee = [...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Edit")[1]!;
    await click(lee);
    expect(dialog().textContent).toContain("Sharing with Lee");
    await choose(dialog(), "Status only");
    await click(dialogButton("Save"));
    expect(sent[1]).toBe('PUT u3 {"level":"coarse"}');

    await click(button("Edit"));
    await choose(dialog(), "Not sharing");
    await click(dialogButton("Save"));
    expect(sent[2]).toBe("DELETE u2");
  });

  it("Agents shows a refused create inside the dialog and keeps the name", async () => {
    route("GET /v1/tokens", () => ({ status: 200, body: { tokens: [] } }));
    route("GET /v1/oauth/grants", () => ({ status: 200, body: { grants: [] } }));
    route("POST /v1/tokens", () => ({ status: 400, body: { error: "name too long" } }));
    await open("#agents");
    await click(button("New agent token"));
    await fill(inputLabelled(dialog(), "Name"), "x");
    await click(dialogButton("Create token"));
    expect(dialog().textContent).toContain("Some of the values aren't valid.");
    expect(inputLabelled(dialog(), "Name").value).toBe("x");
    await pressEscape();
    expect(openDialog()).toBeUndefined();
  });
});
