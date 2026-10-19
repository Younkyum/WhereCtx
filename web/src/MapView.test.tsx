// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableJavaScriptFileLoading":true,"disableIframePageLoading":true}}
//
// The dashboard side of a map: what it asks the server, which frame it makes,
// and what it tells that frame. The frame itself (map.html) is a stand-in
// here: each <iframe>'s window records what the dashboard posts to it, and a
// test answers as the frame would (mapFrame.test.ts holds the real frame to
// the same messages).
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FromFrame, MapScene, ToFrame } from "./mapScene";

type Reply = { status: number; body?: unknown };

const ME = { user: { id: "u1", displayName: "Me" }, workspaces: [{ id: "w1", name: "Home", role: "owner" }], passkeys: [], sessions: [] };
const KAKAO = { provider: "kakao", sdkUrl: "https://dapi.kakao.com/v2/maps/sdk.js?appkey=testkey12345&autoload=false" };
const NAVER = { provider: "naver", sdkUrl: "https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=naverkey123" };
const PLACES = [{ name: "home", type: "home", lat: 37.5, lon: 127, radiusM: 100 }];
const POINTS = [
  { id: "p1", recordedAt: "2026-10-18T01:00:00.000Z", lat: 37.5, lon: 127 },
  { id: "p2", recordedAt: "2026-10-18T01:05:00.000Z", lat: 37.52, lon: 127.03 },
];

let routes: Map<string, () => Reply>;
let calls: string[];
let host: HTMLElement;
let root: Root;
let act: typeof import("react").act;

/** What the dashboard posted to each frame window, by frame. */
const frameWindows = new WeakMap<HTMLIFrameElement, { posted: ToFrame[] }>();
const frames = () => [...host.querySelectorAll("iframe")];
const posted = (frame = frames()[0]!) => (frame.contentWindow as unknown as { posted: ToFrame[] }).posted;
const scenes = (frame?: HTMLIFrameElement) => posted(frame).flatMap((m) => (m.type === "draw" ? [m.scene] : []));
const lastScene = (frame?: HTMLIFrameElement): MapScene => scenes(frame).at(-1)!;
const scripts = () => [...document.querySelectorAll("script[src]")] as HTMLScriptElement[];

/** The frame says something to the dashboard; by default as itself, from this origin. */
async function frameSays(message: FromFrame | unknown, opts: { frame?: HTMLIFrameElement; source?: unknown; origin?: string } = {}) {
  const frame = opts.frame ?? frames()[0]!;
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", { data: message, source: (opts.source ?? frame.contentWindow) as Window, origin: opts.origin ?? location.origin }),
    );
  });
  await settle();
}

/** The frame comes up, loads the map it is told to, and is ready to draw. */
async function frameReady(frame?: HTMLIFrameElement) {
  await frameSays({ type: "hello" }, { frame });
  await frameSays({ type: "ready" }, { frame });
}

async function settle() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** A fresh page: the app and the map's page-wide memory start over. */
async function open(hash: string) {
  vi.resetModules();
  const [{ App }, { createRoot }, react] = await Promise.all([import("./App"), import("react-dom/client"), import("react")]);
  act = react.act;
  location.hash = hash;
  root = createRoot(host);
  await act(async () => root.render(react.createElement(App)));
  await settle();
}

async function go(hash: string) {
  await act(async () => {
    location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await settle();
}

function button(name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
  if (!found) throw new Error(`no button "${name}" in: ${host.textContent}`);
  return found;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  routes = new Map([
    ["GET /v1/me", () => ({ status: 200, body: ME })],
    ["GET /v1/places", () => ({ status: 200, body: { places: PLACES } })],
    ["GET /v1/presence/history", () => ({ status: 200, body: { enabled: true, retentionHours: 24, from: "", to: "", truncated: false, points: POINTS } })],
  ]);
  calls = [];
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    const key = `${init.method ?? "GET"} ${path}`;
    calls.push(key);
    const out = (routes.get(key) ?? routes.get(key.split("?")[0]!))?.() ?? { status: 404, body: { error: "not found" } };
    return new Response(out.body === undefined ? "" : JSON.stringify(out.body), { status: out.status });
  });
  Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
    configurable: true,
    get(this: HTMLIFrameElement) {
      if (!frameWindows.has(this)) {
        const record = { posted: [] as ToFrame[], postMessage: (m: ToFrame) => record.posted.push(m) };
        frameWindows.set(this, record);
      }
      return frameWindows.get(this);
    },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  location.hash = "";
  vi.unstubAllGlobals();
});

describe("maps in the dashboard", () => {
  it("without a map key, draws History from the points alone and makes no frame", async () => {
    routes.set("GET /v1/geo/map-config", () => ({ status: 200, body: { provider: null } }));
    await open("#history");
    expect(calls).toContain("GET /v1/geo/map-config");
    expect(host.querySelector('svg[role="img"] path')).not.toBeNull();
    expect(frames()).toEqual([]);
    expect(host.textContent).not.toContain("The map could not load");
  });

  it("when the map config cannot be read, also falls back with no frame", async () => {
    await open("#history");
    expect(host.querySelector('svg[role="img"] path')).not.toBeNull();
    expect(frames()).toEqual([]);
  });

  it("with a map key, frames the map page, tells it which script to load, and draws History in it; the dashboard itself loads no script", async () => {
    routes.set("GET /v1/geo/map-config", () => ({ status: 200, body: KAKAO }));
    await open("#history");
    expect(frames().map((f) => f.getAttribute("src"))).toEqual(["/map.html"]);
    expect(posted()).toEqual([]);
    await frameReady();
    expect(posted()[0]).toEqual({ type: "load", map: KAKAO });
    expect(lastScene()).toEqual({
      markers: [{ id: "latest", at: { lat: 37.52, lon: 127.03 }, title: "Latest point" }],
      circles: [{ id: "place:home", at: { lat: 37.5, lon: 127 }, radiusM: 100, title: "home" }],
      lines: [{ id: "track", points: [{ lat: 37.5, lon: 127 }, { lat: 37.52, lon: 127.03 }] }],
    });
    expect(posted().filter((m) => m.type === "draw").every((m) => m.type === "draw" && !m.pickable)).toBe(true);
    expect(host.querySelector('svg[role="img"]')).toBeNull();
    expect(scripts()).toEqual([]);
    expect(host.textContent).toContain("2026");
  });

  it("listens only to its own frame at this origin, and only to well-formed messages", async () => {
    routes.set("GET /v1/geo/map-config", () => ({ status: 200, body: KAKAO }));
    await open("#history");
    await frameSays({ type: "hello" }, { source: window });
    await frameSays({ type: "hello" }, { origin: "https://evil.example" });
    await frameSays({ type: "failed", why: "because" });
    await frameSays({ type: "pick", at: { lat: 100, lon: 0 } });
    expect(posted()).toEqual([]);
    await frameSays({ type: "ready" }, { origin: "https://evil.example" });
    expect(frames()[0]!.getAttribute("aria-busy")).toBe("true");
    expect(host.textContent).not.toContain("The map could not load");
  });

  it("names no frame for a script outside the provider's origin, and says why", async () => {
    routes.set("GET /v1/geo/map-config", () => ({ status: 200, body: { provider: "kakao", sdkUrl: "https://evil.example/sdk.js" } }));
    await open("#history");
    expect(frames()).toEqual([]);
    expect(host.querySelector('svg[role="img"] path')).not.toBeNull();
    expect(host.textContent).toContain("security policy blocked");
  });

  it("falls back to the drawn track and says the script failed when the frame could not load it", async () => {
    routes.set("GET /v1/geo/map-config", () => ({ status: 200, body: KAKAO }));
    await open("#history");
    await frameSays({ type: "hello" });
    await frameSays({ type: "failed", why: "load" });
    expect(frames()).toEqual([]);
    expect(host.querySelector('svg[role="img"] path')).not.toBeNull();
    expect(host.textContent).toContain("Kakao's map script failed or did not answer");
  });

  it("tells a blocked map apart from a key problem", async () => {
    routes.set("GET /v1/geo/map-config", () => ({ status: 200, body: KAKAO }));
    await open("#history");
    await frameReady();
    await frameSays({ type: "failed", why: "blocked" });
    expect(host.textContent).toContain("That is a problem with this server, not with your map key.");
    expect(host.textContent).not.toContain("refused the map key");
  });

  it("remembers that Naver refused the key, so the next map on the page falls back without a frame", async () => {
    routes.set("GET /v1/geo/map-config", () => ({ status: 200, body: NAVER }));
    await open("#history");
    await frameReady();
    await frameSays({ type: "failed", why: "refused" });
    expect(host.querySelector('svg[role="img"] path')).not.toBeNull();
    expect(host.textContent).toContain("Naver refused the map key");

    await go("#places");
    expect(calls.filter((c) => c === "GET /v1/geo/map-config")).toHaveLength(2);
    expect(frames()).toEqual([]);
    expect(host.textContent).toContain("Naver refused the map key");
  });

  describe("Home", () => {
    const mina = { user: { id: "u2", displayName: "Mina" }, level: "precise", paused: false, presence: { status: "away", stale: false, updatedAgoMin: 1 } };
    let minaAvailable: boolean;

    beforeEach(() => {
      minaAvailable = true;
      routes.set("GET /v1/privacy", () => ({ status: 200, body: { settings: { geoEnabled: true } } }));
      routes.set("GET /v1/presence", () => ({ status: 200, body: { status: "away", updatedAgoSec: 60, stale: false, freshness: "live" } }));
      routes.set("GET /v1/presence/precise", () => ({ status: 200, body: { lat: 37.4, lon: 127.1, accuracyM: 10, updatedAgoSec: 60 } }));
      routes.set("GET /v1/people", () => ({ status: 200, body: { people: [{ ...mina, precise: minaAvailable ? "available" : null }] } }));
      routes.set("GET /v1/people/u2", () => ({ status: 200, body: { person: { ...mina, precise: { lat: 37.55, lon: 126.95, updatedAgoMin: 3 } } } }));
    });

    const markers = () => lastScene().markers.map((m) => [m.title, m.at.lat, m.at.lon]);
    async function openMina() {
      await act(async () => button("Show exact location").click());
      await settle();
    }

    it("without a map, never reads my point", async () => {
      routes.set("GET /v1/geo/map-config", () => ({ status: 200, body: { provider: null } }));
      await open("#home");
      expect(calls).toContain("GET /v1/geo/map-config");
      expect(calls).not.toContain("GET /v1/presence/precise");
      expect(frames()).toEqual([]);
    });

    it("places me, and a person only after their exact location is opened (the audited read), with its age", async () => {
      routes.set("GET /v1/geo/map-config", () => ({ status: 200, body: KAKAO }));
      await open("#home");
      await frameReady();
      expect(markers()).toEqual([["You", 37.4, 127.1]]);
      expect(calls).not.toContain("GET /v1/people/u2");

      await openMina();
      expect(calls).toContain("GET /v1/people/u2");
      expect(markers()).toEqual([
        ["You", 37.4, 127.1],
        ["Mina · 3 min ago", 37.55, 126.95],
      ]);
    });

    it("near home, while the provider is kept away from there, shows my home place and not my point", async () => {
      routes.set("GET /v1/geo/map-config", () => ({ status: 200, body: KAKAO }));
      routes.set("GET /v1/presence/precise", () => ({
        status: 200,
        body: { lat: 37.5004, lon: 127.0003, updatedAgoSec: 60, nearHome: { name: "home", lat: 37.5, lon: 127, radiusM: 100 } },
      }));
      await open("#home");
      await frameReady();
      expect(lastScene().markers).toEqual([]);
      expect(lastScene().circles).toEqual([{ id: "place:home", at: { lat: 37.5, lon: 127 }, radiusM: 100, title: "home" }]);
      expect(JSON.stringify(scenes())).not.toContain("37.5004");
      expect(host.textContent).toContain("You are near home, so the map shows that place, not your position.");
    });

    it("drops an opened person when the list stops saying their exact location is available, and after five minutes", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
      try {
        routes.set("GET /v1/geo/map-config", () => ({ status: 200, body: KAKAO }));
        await open("#home");
        await frameReady();
        await openMina();
        expect(markers().map((m) => m[0])).toEqual(["You", "Mina · 3 min ago"]);
        const preciseReads = () => calls.filter((c) => c === "GET /v1/presence/precise").length;
        const before = preciseReads();

        await act(async () => vi.advanceTimersByTime(30_000));
        await settle();
        expect(markers().map((m) => m[0])).toEqual(["You", "Mina · 3 min ago"]);
        expect(preciseReads()).toBe(before + 1);

        minaAvailable = false;
        await act(async () => vi.advanceTimersByTime(30_000));
        await settle();
        expect(markers().map((m) => m[0])).toEqual(["You"]);
        expect(host.textContent).not.toContain("37.55");

        minaAvailable = true;
        await act(async () => vi.advanceTimersByTime(30_000));
        await settle();
        await openMina();
        expect(markers().map((m) => m[0])).toEqual(["You", "Mina · 3 min ago"]);
        await act(async () => vi.advanceTimersByTime(4 * 60_000));
        await settle();
        expect(markers().map((m) => m[0])).toEqual(["You", "Mina · 7 min ago"]);
        await act(async () => vi.advanceTimersByTime(60_000));
        await settle();
        expect(markers().map((m) => m[0])).toEqual(["You"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("reads my status even while agents are kept from it, and says they are", async () => {
      routes.set("GET /v1/geo/map-config", () => ({ status: 200, body: { provider: null } }));
      routes.set("GET /v1/privacy", () => ({ status: 200, body: { settings: { geoEnabled: true, defaultAgentAccess: "hidden" } } }));
      await open("#home");
      expect(host.textContent).toContain("hidden from agents");
      expect(host.textContent).toContain("Away");
    });
  });

  it("Places draws each place's circle, and a click in the frame fills in the new place's coordinates", async () => {
    routes.set("GET /v1/geo/map-config", () => ({ status: 200, body: KAKAO }));
    await open("#places");
    await frameReady();
    expect(lastScene().circles.map((c) => [c.at.lat, c.at.lon, c.radiusM])).toEqual([[37.5, 127, 100]]);
    expect(posted().at(-1)).toMatchObject({ type: "draw", pickable: true });
    await frameSays({ type: "pick", at: { lat: 37.1234567, lon: 127.7654321 } });
    const values = [...host.querySelectorAll("input")].map((i) => i.value);
    expect(values).toContain("37.123457");
    expect(values).toContain("127.765432");
    expect(lastScene().markers.map((m) => [m.at.lat, m.at.lon])).toEqual([[37.1234567, 127.7654321]]);
  });

  describe("Maps & routes keys", () => {
    const row = (over: Record<string, unknown>) => ({ provider: "kakao", status: "ok", rest: false, map: false, kinds: {}, updatedAt: "", lastUsedAt: null, lastError: null, ...over });
    const geo = (credentials: unknown[]) => () => ({ status: 200, body: { active: null, map: null, credentials, operator: [], operatorMap: [] } });

    beforeEach(() => {
      routes.set("GET /v1/geo/map-config", () => ({ status: 200, body: { provider: null } }));
      routes.set("GET /v1/privacy", () => ({ status: 200, body: { settings: { geoEnabled: false, geoProvider: null } } }));
    });

    it("a provider with only a map key shows no saved REST key, and its map key in the map panel", async () => {
      routes.set("GET /v1/geo", geo([row({ map: true, kinds: { jsKey: "c123" } })]));
      await open("#maps");
      expect(host.textContent).toContain("Map key ••••c123");
      expect(host.textContent).not.toContain("Saved key");
      expect([...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Test")).toEqual([]);
    });

    it("a REST key alone shows no map key", async () => {
      routes.set("GET /v1/geo", geo([row({ rest: true, kinds: { restKey: "cdef" } })]));
      await open("#maps");
      expect(host.textContent).toContain("Saved key ••••cdef");
      expect(host.textContent).not.toContain("Map key ••••");
    });

    it("deleting the REST key says the map key stays", async () => {
      routes.set("GET /v1/geo", geo([row({ rest: true, map: true, kinds: { restKey: "cdef", jsKey: "c123" } })]));
      await open("#maps");
      await act(async () => button("Delete").click());
      await settle();
      expect(document.body.textContent).toContain("Remove your Kakao REST key? Your map key stays.");
    });
  });

  it("the route tester draws the owner's route", async () => {
    routes.set("GET /v1/geo/map-config", () => ({ status: 200, body: KAKAO }));
    routes.set("GET /v1/geo", () => ({ status: 200, body: { active: { provider: "kakao", source: "own" }, map: { provider: "kakao", source: "own" }, credentials: [], operator: [], operatorMap: [] } }));
    routes.set("GET /v1/privacy", () => ({ status: 200, body: { settings: { geoEnabled: true, geoProvider: null } } }));
    const path = [
      { lat: 37.4, lon: 127.1 },
      { lat: 37.45, lon: 127.05 },
      { lat: 37.5, lon: 127 },
    ];
    routes.set("GET /v1/geo/eta", () => ({
      status: 200,
      body: { eta: { destination: { label: "home", kind: "place" }, origin: "current_location", precision: "exact", durationMin: 12, distanceKm: 6.1, traffic: "live", arriveAt: "2026-10-19T01:00:00Z", summary: [], path, provider: "kakao" } },
    }));
    await open("#maps");
    expect(host.textContent).toContain(`register this site domain: ${location.origin}`);
    const to = [...host.querySelectorAll("label")].find((l) => l.textContent?.trim() === "To a place name or an address")!;
    const input = (document.getElementById(to.htmlFor) ?? to.parentElement!.querySelector("input")) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "home");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Get ETA").click());
    await settle();
    await frameReady();
    expect(lastScene().lines.map((l) => l.points)).toEqual([path]);
    expect(lastScene().markers.map((m) => m.title)).toEqual(["Start", "home"]);
  });
});
