// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableJavaScriptFileLoading":true,"handleDisabledFileLoadingAsSuccess":false}}
//
// The provider SDKs are never fetched here: happy-dom does not load script
// files, and answers each one with a load or an error event as a test sets.
// A stand-in `kakao.maps` / `naver.maps` records what a page draws, which is
// what the provider would be sent.
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Reply = { status: number; body?: unknown };
type Overlay = { kind: "marker" | "circle" | "line"; opts: any; live: boolean };

const ME = { user: { id: "u1", displayName: "Me" }, workspaces: [{ id: "w1", name: "Home", role: "owner" }], passkeys: [], sessions: [] };
const KAKAO = { provider: "kakao", sdkUrl: "https://dapi.kakao.com/v2/maps/sdk.js?appkey=testkey12345&autoload=false", key: "testkey12345" };
const NAVER = { provider: "naver", sdkUrl: "https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=naverkey123", key: "naverkey123" };
const PLACES = [{ name: "home", type: "home", lat: 37.5, lon: 127, radiusM: 100 }];
const POINTS = [
  { id: "p1", recordedAt: "2026-10-18T01:00:00.000Z", lat: 37.5, lon: 127 },
  { id: "p2", recordedAt: "2026-10-18T01:05:00.000Z", lat: 37.52, lon: 127.03 },
];

let routes: Map<string, () => Reply>;
let calls: string[];
let overlays: Overlay[];
let clicks: ((e: unknown) => void)[];
let host: HTMLElement;
let root: Root;
let act: typeof import("react").act;

const happyDOM = () => (window as unknown as { happyDOM: { settings: { handleDisabledFileLoadingAsSuccess: boolean } } }).happyDOM;

function fakeMaps() {
  class LatLng {
    constructor(
      readonly lat: number,
      readonly lng: number,
    ) {}
  }
  const overlay = (kind: Overlay["kind"]) =>
    class {
      private readonly record: Overlay;
      constructor(opts: any) {
        this.record = { kind, opts, live: true };
        overlays.push(this.record);
      }
      setMap(map: unknown) {
        if (map === null) this.record.live = false;
      }
    };
  const map = class {
    setCenter() {}
    setLevel() {}
    setZoom() {}
    setBounds() {}
    fitBounds() {}
    destroy() {}
  };
  const listen = (_map: unknown, _event: string, fn: (e: unknown) => void) => clicks.push(fn);
  return {
    load: (ready: () => void) => ready(),
    LatLng,
    LatLngBounds: class {},
    Map: map,
    Marker: overlay("marker"),
    Circle: overlay("circle"),
    Polyline: overlay("line"),
    event: { addListener: listen },
    Event: { addListener: listen },
  };
}

const live = (kind: Overlay["kind"]) => overlays.filter((o) => o.kind === kind && o.live);
const at = (o: Overlay) => {
  const p = o.opts.position ?? o.opts.center;
  return [p.lat, p.lng];
};
const scripts = () => [...document.querySelectorAll("script[src]")] as HTMLScriptElement[];

async function settle() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** A fresh page: the app and its one-script-per-page map loader start over. */
async function open(hash: string) {
  vi.resetModules();
  const [{ App }, { createRoot }, react] = await Promise.all([import("./App"), import("react-dom/client"), import("react")]);
  act = react.act;
  location.hash = hash;
  root = createRoot(host);
  await act(async () => root.render(react.createElement(App)));
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
  overlays = [];
  clicks = [];
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    const key = `${init.method ?? "GET"} ${path}`;
    calls.push(key);
    const out = (routes.get(key) ?? routes.get(key.split("?")[0]!))?.() ?? { status: 404, body: { error: "not found" } };
    return new Response(out.body === undefined ? "" : JSON.stringify(out.body), { status: out.status });
  });
  const w = window as unknown as Record<string, unknown>;
  w.kakao = { maps: fakeMaps() };
  w.naver = { maps: fakeMaps() };
  happyDOM().settings.handleDisabledFileLoadingAsSuccess = true;
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  for (const s of scripts()) s.remove();
  location.hash = "";
  vi.unstubAllGlobals();
});

describe("maps in the dashboard", () => {
  it("without a map key, draws History from the points alone and never adds a provider script", async () => {
    routes.set("GET /v1/geo/map-config", () => ({ status: 200, body: { provider: null } }));
    await open("#history");
    expect(calls).toContain("GET /v1/geo/map-config");
    expect(host.querySelector('svg[role="img"] path')).not.toBeNull();
    expect(scripts()).toEqual([]);
    expect(overlays).toEqual([]);
    expect(host.textContent).not.toContain("The map could not load");
  });

  it("when the map config cannot be read, also falls back with no provider script", async () => {
    await open("#history");
    expect(host.querySelector('svg[role="img"] path')).not.toBeNull();
    expect(scripts()).toEqual([]);
  });

  it("with a map key, loads the provider's script once, sending only the origin, and draws History on it", async () => {
    routes.set("GET /v1/geo/map-config", () => ({ status: 200, body: KAKAO }));
    await open("#history");
    expect(scripts().map((s) => [s.src, s.referrerPolicy])).toEqual([[KAKAO.sdkUrl, "strict-origin"]]);
    expect(host.querySelector('svg[role="img"]')).toBeNull();
    expect(live("line").map((l) => l.opts.path.map((p: any) => [p.lat, p.lng]))).toEqual([
      [
        [37.5, 127],
        [37.52, 127.03],
      ],
    ]);
    expect(live("marker").map(at)).toEqual([[37.52, 127.03]]);
    expect(live("circle").map((c) => [...at(c), c.opts.radius])).toEqual([[37.5, 127, 100]]);
    expect(host.textContent).toContain("2026");
  });

  it("falls back to the drawn track, and says why, when the script does not load", async () => {
    happyDOM().settings.handleDisabledFileLoadingAsSuccess = false;
    routes.set("GET /v1/geo/map-config", () => ({ status: 200, body: KAKAO }));
    await open("#history");
    expect(host.querySelector('svg[role="img"] path')).not.toBeNull();
    expect(host.textContent).toContain("The map could not load");
    expect(overlays).toEqual([]);
  });

  it("falls back when Naver refuses the key after its script loaded", async () => {
    routes.set("GET /v1/geo/map-config", () => ({ status: 200, body: NAVER }));
    await open("#history");
    expect(live("line")).toHaveLength(1);
    await act(async () => (window as unknown as { navermap_authFailure: () => void }).navermap_authFailure());
    expect(host.querySelector('svg[role="img"] path')).not.toBeNull();
    expect(host.textContent).toContain("The map could not load");
  });

  it("Home places me, and a person only after their exact location is opened (the audited read)", async () => {
    routes.set("GET /v1/geo/map-config", () => ({ status: 200, body: KAKAO }));
    routes.set("GET /v1/privacy", () => ({ status: 200, body: { settings: { geoEnabled: true } } }));
    routes.set("GET /v1/presence", () => ({ status: 200, body: { status: "away", updatedAgoSec: 60, stale: false, freshness: "live" } }));
    routes.set("GET /v1/presence/precise", () => ({ status: 200, body: { lat: 37.4, lon: 127.1, accuracyM: 10, updatedAgoSec: 60 } }));
    const mina = { user: { id: "u2", displayName: "Mina" }, level: "precise", paused: false, presence: { status: "away", stale: false, updatedAgoMin: 1 } };
    routes.set("GET /v1/people", () => ({ status: 200, body: { people: [{ ...mina, precise: "available" }] } }));
    routes.set("GET /v1/people/u2", () => ({
      status: 200,
      body: { person: { ...mina, precise: { lat: 37.55, lon: 126.95, updatedAgoMin: 1 } } },
    }));
    await open("#home");
    expect(live("marker").map((m) => [m.opts.title, ...at(m)])).toEqual([["You", 37.4, 127.1]]);
    expect(calls).not.toContain("GET /v1/people/u2");

    await act(async () => button("Show exact location").click());
    await settle();
    expect(calls).toContain("GET /v1/people/u2");
    expect(live("marker").map((m) => [m.opts.title, ...at(m)])).toEqual([
      ["You", 37.4, 127.1],
      ["Mina", 37.55, 126.95],
    ]);
  });

  it("Places draws each place's circle, and a click on the map fills in the new place's coordinates", async () => {
    routes.set("GET /v1/geo/map-config", () => ({ status: 200, body: KAKAO }));
    await open("#places");
    expect(live("circle").map((c) => [...at(c), c.opts.radius])).toEqual([[37.5, 127, 100]]);
    await act(async () => clicks[0]!({ latLng: { getLat: () => 37.1234567, getLng: () => 127.7654321 } }));
    await settle();
    const values = [...host.querySelectorAll("input")].map((i) => i.value);
    expect(values).toContain("37.123457");
    expect(values).toContain("127.765432");
    expect(live("marker").map(at)).toEqual([[37.1234567, 127.7654321]]);
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
    expect(live("line").map((l) => l.opts.path.map((p: any) => [p.lat, p.lng]))).toEqual([path.map((p) => [p.lat, p.lon])]);
    expect(live("marker").map((m) => m.opts.title)).toEqual(["Start", "home"]);
  });
});
