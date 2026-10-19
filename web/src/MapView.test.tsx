// @vitest-environment happy-dom
//
// The dashboard side of a map: what it asks the server and what it draws.
// The Leaflet canvas (mapCanvas.ts) is a recorder here: each map made keeps
// its tiles and every scene drawn on it, and a test can click it or fail a
// tile as Leaflet would (mapCanvas.test.ts holds the real canvas to that).
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LatLon, MapScene } from "./mapScene";
import type { MapTiles } from "./mapCanvas";

type Reply = { status: number; body?: unknown };

const ME = { user: { id: "u1", displayName: "Me" }, workspaces: [{ id: "w1", name: "Home", role: "owner" }], passkeys: [], sessions: [] };
const TILES: MapTiles = { url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", attribution: "© OpenStreetMap contributors", attributionUrl: "https://www.openstreetmap.org/copyright" };
const PLACES = [{ name: "home", type: "home", lat: 37.5, lon: 127, radiusM: 100 }];
const POINTS = [
  { id: "p1", recordedAt: "2026-10-18T01:00:00.000Z", lat: 37.5, lon: 127 },
  { id: "p2", recordedAt: "2026-10-18T01:05:00.000Z", lat: 37.52, lon: 127.03 },
];

interface Canvas {
  tiles: MapTiles;
  draws: { scene: MapScene; pickable: boolean }[];
  pick: (at: LatLon) => void;
  tileError: () => void;
  destroyed: boolean;
}
const canvases: Canvas[] = [];

vi.mock("./mapCanvas", () => ({
  createMapCanvas(_el: HTMLElement, tiles: MapTiles, pick: (at: LatLon) => void, tileError: () => void) {
    const canvas: Canvas = { tiles, draws: [], pick, tileError, destroyed: false };
    canvases.push(canvas);
    return { draw: (scene: MapScene, pickable: boolean) => canvas.draws.push({ scene, pickable }), destroy: () => (canvas.destroyed = true) };
  },
}));

let routes: Map<string, () => Reply>;
let calls: string[];
let host: HTMLElement;
let root: Root;
let act: typeof import("react").act;

const live = () => canvases.filter((c) => !c.destroyed);
const lastScene = (): MapScene => live().at(-1)!.draws.at(-1)!.scene;
const scripts = () => [...document.querySelectorAll("script[src]")] as HTMLScriptElement[];
const withTiles = () => routes.set("GET /v1/geo/map-config", () => ({ status: 200, body: { tiles: TILES } }));
const noTiles = () => routes.set("GET /v1/geo/map-config", () => ({ status: 200, body: { tiles: null } }));

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
  canvases.length = 0;
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
  it("without tiles, draws History from the points alone and makes no map", async () => {
    noTiles();
    await open("#history");
    expect(calls).toContain("GET /v1/geo/map-config");
    expect(host.querySelector('svg[role="img"] path')).not.toBeNull();
    expect(canvases).toEqual([]);
  });

  it("when the map config cannot be read, also falls back with no map", async () => {
    await open("#history");
    expect(host.querySelector('svg[role="img"] path')).not.toBeNull();
    expect(canvases).toEqual([]);
  });

  it("with tiles, draws History on a map in the page, from the server's tiles, loading no script and no frame", async () => {
    withTiles();
    await open("#history");
    expect(live().map((c) => c.tiles)).toEqual([TILES]);
    expect(lastScene()).toEqual({
      markers: [{ id: "latest", at: { lat: 37.52, lon: 127.03 }, title: "Latest point" }],
      circles: [{ id: "place:home", at: { lat: 37.5, lon: 127 }, radiusM: 100, title: "home" }],
      polygons: [],
      lines: [{ id: "track", points: [{ lat: 37.5, lon: 127 }, { lat: 37.52, lon: 127.03 }] }],
    });
    expect(live()[0]!.draws.every((d) => !d.pickable)).toBe(true);
    expect(host.querySelector('svg[role="img"]')).toBeNull();
    expect(scripts()).toEqual([]);
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
    expect(host.textContent).toContain("2026");
  });

  it("says when tiles fail to load, naming the tile host, and keeps the map", async () => {
    withTiles();
    await open("#history");
    await act(async () => live()[0]!.tileError());
    await settle();
    expect(host.textContent).toContain("Some map tiles could not load from tile.openstreetmap.org.");
    expect(live()).toHaveLength(1);
  });

  it("makes a fresh map per page and lets go of the last one", async () => {
    withTiles();
    await open("#history");
    await go("#places");
    expect(canvases).toHaveLength(2);
    expect(canvases[0]!.destroyed).toBe(true);
    expect(live()).toHaveLength(1);
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
      noTiles();
      await open("#home");
      expect(calls).toContain("GET /v1/geo/map-config");
      expect(calls).not.toContain("GET /v1/presence/precise");
      expect(canvases).toEqual([]);
    });

    it("draws the map with maps (geoEnabled) off: no provider key is involved", async () => {
      withTiles();
      routes.set("GET /v1/privacy", () => ({ status: 200, body: { settings: { geoEnabled: false } } }));
      await open("#home");
      expect(lastScene().markers.map((m) => m.title)).toEqual(["You"]);
    });

    it("places me, and a person only after their exact location is opened (the audited read), with its age", async () => {
      withTiles();
      await open("#home");
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
      withTiles();
      routes.set("GET /v1/presence/precise", () => ({
        status: 200,
        body: { lat: 37.5004, lon: 127.0003, updatedAgoSec: 60, nearHome: { name: "home", lat: 37.5, lon: 127, radiusM: 100 } },
      }));
      await open("#home");
      expect(lastScene().markers).toEqual([]);
      expect(lastScene().circles).toEqual([{ id: "place:home", at: { lat: 37.5, lon: 127 }, radiusM: 100, title: "home" }]);
      expect(JSON.stringify(live()[0]!.draws)).not.toContain("37.5004");
      expect(host.textContent).toContain("You are near home, so the map shows that place, not your position.");
    });

    it("drops an opened person when the list stops saying their exact location is available, and after five minutes", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
      try {
        withTiles();
        await open("#home");
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
      noTiles();
      routes.set("GET /v1/privacy", () => ({ status: 200, body: { settings: { geoEnabled: true, defaultAgentAccess: "hidden" } } }));
      await open("#home");
      expect(host.textContent).toContain("hidden from agents");
      expect(host.textContent).toContain("Away");
    });
  });

  it("Places draws each place's circle, and a click on the map opens Add by coordinates with the point filled in", async () => {
    withTiles();
    await open("#places");
    expect(lastScene().circles.map((c) => [c.at.lat, c.at.lon, c.radiusM])).toEqual([[37.5, 127, 100]]);
    expect(live()[0]!.draws.at(-1)!.pickable).toBe(true);
    await act(async () => live()[0]!.pick({ lat: 37.1234567, lon: 127.7654321 }));
    await settle();
    expect(document.querySelector("dialog[open]")?.textContent).toContain("Add by coordinates");
    const values = [...document.querySelectorAll("dialog[open] input")].map((i) => (i as HTMLInputElement).value);
    expect(values).toContain("37.123457");
    expect(values).toContain("127.765432");
    expect(lastScene().markers.map((m) => [m.at.lat, m.at.lon])).toEqual([[37.1234567, 127.7654321]]);
  });

  it("Places draws a polygon place along its outline, not as the circle around it", async () => {
    withTiles();
    const ring: Array<[number, number]> = [[127, 37.5], [127.002, 37.5], [127.002, 37.502], [127, 37.5]];
    routes.set("GET /v1/places", () => ({
      status: 200,
      body: { places: [...PLACES, { name: "park", type: "custom", lat: 37.5007, lon: 127.0013, radiusM: 180, polygon: ring }] },
    }));
    await open("#places");
    expect(lastScene().circles.map((c) => c.title)).toEqual(["home"]);
    expect(lastScene().polygons).toEqual([
      { id: "place:park", ring: ring.map(([lon, lat]) => ({ lat, lon })), title: "park" },
    ]);
  });

  describe("Maps & routes", () => {
    beforeEach(() => {
      routes.set("GET /v1/privacy", () => ({ status: 200, body: { settings: { geoEnabled: false, geoProvider: null } } }));
      routes.set("GET /v1/geo", () => ({ status: 200, body: { active: null, credentials: [], operator: [] } }));
    });

    it("says maps need no key, and what the tile server sees", async () => {
      withTiles();
      await open("#maps");
      expect(host.textContent).toContain("Maps here need no maps key and work with maps off.");
      expect(host.textContent).toContain("map tiles from tile.openstreetmap.org");
      expect(host.textContent).not.toMatch(/map key|JavaScript key/i);
    });

    it("says when the server draws no maps", async () => {
      noTiles();
      await open("#maps");
      expect(host.textContent).toContain("This server draws no maps (MAP_TILE_URL is off).");
    });
  });

  it("the route tester draws the owner's route", async () => {
    withTiles();
    routes.set("GET /v1/geo", () => ({ status: 200, body: { active: { provider: "kakao", source: "own" }, credentials: [], operator: [] } }));
    routes.set("GET /v1/privacy", () => ({ status: 200, body: { settings: { geoEnabled: true, geoProvider: null } } }));
    const path = [
      { lat: 37.4, lon: 127.1 },
      { lat: 37.45, lon: 127.05 },
      { lat: 37.5, lon: 127 },
    ];
    routes.set("GET /v1/geo/eta", () => ({
      status: 200,
      body: { eta: { mode: "car", destination: { label: "home", kind: "place" }, origin: "current_location", precision: "exact", durationMin: 12, distanceKm: 6.1, traffic: "live", arriveAt: "2026-10-19T01:00:00Z", summary: [], path, provider: "kakao" } },
    }));
    await open("#maps");
    const to = [...host.querySelectorAll("label")].find((l) => l.textContent?.trim() === "To a place name or an address")!;
    const input = (document.getElementById(to.htmlFor) ?? to.parentElement!.querySelector("input")) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "home");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Get ETA").click());
    await settle();
    expect(lastScene().lines.map((l) => l.points)).toEqual([path]);
    expect(lastScene().markers.map((m) => m.title)).toEqual(["Start", "home"]);
  });

  it("the route tester asks by transit, draws each leg with walks dashed, and lists the rides with their stops", async () => {
    withTiles();
    routes.set("GET /v1/geo", () => ({ status: 200, body: { active: { provider: "kakao", source: "own" }, credentials: [], operator: [] } }));
    routes.set("GET /v1/privacy", () => ({ status: 200, body: { settings: { geoEnabled: true, geoProvider: null } } }));
    const [a, b, c, d] = [
      { lat: 37.4, lon: 127.1 },
      { lat: 37.41, lon: 127.09 },
      { lat: 37.49, lon: 127.01 },
      { lat: 37.5, lon: 127 },
    ];
    const legs = [
      { kind: "walk", durationMin: 4, distanceM: 300, lines: [], stops: [], path: [a, b] },
      { kind: "subway", durationMin: 20, distanceM: 11000, lines: ["2호선"], stops: ["판교", "양재", "강남"], path: [b, c] },
      { kind: "subway", durationMin: 3, distanceM: 2000, lines: ["신분당선"], stops: ["판교", "양재"], path: [c, c] },
      { kind: "walk", durationMin: 3, distanceM: 200, lines: [], stops: [], path: [c, d] },
    ];
    routes.set("GET /v1/geo/eta", () => ({
      status: 200,
      body: {
        eta: {
          mode: "transit", destination: { label: "home", kind: "place" }, origin: "current_location", precision: "exact", durationMin: 27, distanceKm: 11.5,
          arriveAt: "2026-10-19T01:00:00Z", summary: ["2호선"], path: [a, b, c, d], legs, transfers: 0, walkMin: 7, fare: 1550, provider: "kakao",
        },
      },
    }));
    await open("#maps");
    await act(async () => button("Transit").click());
    const to = [...host.querySelectorAll("label")].find((l) => l.textContent?.trim() === "To a place name or an address")!;
    const input = (document.getElementById(to.htmlFor) ?? to.parentElement!.querySelector("input")) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "home");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Get ETA").click());
    await settle();
    expect(calls).toContain("GET /v1/geo/eta?to=home&mode=transit");
    expect(lastScene().lines.map((l) => [l.points, Boolean(l.dashed)])).toEqual([
      [[a, b], true],
      [[b, c], false],
      [[c, c], false],
      [[c, d], true],
    ]);
    expect(host.textContent).toContain("2호선, 20 min");
    expect(host.textContent).toContain("판교 → 강남, 2 stops");
    expect(host.textContent).toContain("판교 → 양재, 1 stop");
    expect(host.textContent).toContain("No transfers");
    expect(host.textContent).toContain("₩1,550");
  });
});
