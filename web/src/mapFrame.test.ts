// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableJavaScriptFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
//
// The map frame (map.html) as the dashboard sees it: messages in from its
// parent window, messages out to it. The provider SDKs are never fetched:
// happy-dom answers each script with a load or an error as a test sets, and
// a stand-in `kakao.maps` / `naver.maps` records what is drawn, which is what
// the provider would be sent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FromFrame, MapScene, ToFrame } from "./mapScene";

type Overlay = { kind: "marker" | "circle" | "line"; opts: any; live: boolean };

const KAKAO = { provider: "kakao", sdkUrl: "https://dapi.kakao.com/v2/maps/sdk.js?appkey=testkey12345&autoload=false" } as const;
const NAVER = { provider: "naver", sdkUrl: "https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=naverkey123" } as const;
const SCENE: MapScene = {
  markers: [{ id: "me", at: { lat: 37.4, lon: 127.1 }, title: "You" }],
  circles: [{ id: "place:home", at: { lat: 37.5, lon: 127 }, radiusM: 100, title: "home" }],
  lines: [{ id: "track", points: [{ lat: 37.5, lon: 127 }, { lat: 37.52, lon: 127.03 }] }],
};

let sent: FromFrame[];
let parent: { postMessage(message: FromFrame, origin: string): void };
let overlays: Overlay[];
let clicks: ((e: unknown) => void)[];
let kakaoLoads: boolean;
/** Each test's frame listens on the one test window; these go when the test ends. */
let listeners: [string, EventListenerOrEventListenerObject][];
const addListener = window.addEventListener.bind(window);

const happyDOM = () => (window as unknown as { happyDOM: { settings: { handleDisabledFileLoadingAsSuccess: boolean } } }).happyDOM;
const scripts = () => [...document.querySelectorAll("script[src]")] as HTMLScriptElement[];
const live = (kind: Overlay["kind"]) => overlays.filter((o) => o.kind === kind && o.live);

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
  const listen = (_map: unknown, _event: string, fn: (e: unknown) => void) => clicks.push(fn);
  return {
    load: (ready: () => void) => kakaoLoads && ready(),
    LatLng,
    LatLngBounds: class {},
    Map: class {
      setCenter() {}
      setLevel() {}
      setZoom() {}
      setBounds() {}
      fitBounds() {}
    },
    Marker: overlay("marker"),
    Circle: overlay("circle"),
    Polyline: overlay("line"),
    event: { addListener: listen },
    Event: { addListener: listen },
  };
}

async function settle() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

/** A message as the frame receives it; by default from its parent at this origin. */
async function receive(data: ToFrame | unknown, from: { source?: unknown; origin?: string } = {}) {
  window.dispatchEvent(new MessageEvent("message", { data, source: (from.source ?? parent) as Window, origin: from.origin ?? location.origin }));
  await settle();
}

async function start() {
  vi.resetModules();
  await import("./mapFrame");
  await settle();
}

beforeEach(() => {
  listeners = [];
  vi.spyOn(window, "addEventListener").mockImplementation((type: string, fn: EventListenerOrEventListenerObject) => {
    listeners.push([type, fn]);
    addListener(type, fn);
  });
  sent = [];
  overlays = [];
  clicks = [];
  kakaoLoads = true;
  parent = { postMessage: (message) => sent.push(message) };
  Object.defineProperty(window, "parent", { value: parent, configurable: true });
  const w = window as unknown as Record<string, unknown>;
  w.kakao = { maps: fakeMaps() };
  w.naver = { maps: fakeMaps() };
  happyDOM().settings.handleDisabledFileLoadingAsSuccess = true;
  const el = document.createElement("div");
  el.id = "map";
  document.body.appendChild(el);
});

afterEach(() => {
  for (const [type, fn] of listeners) window.removeEventListener(type, fn);
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
  for (const s of scripts()) s.remove();
  Object.defineProperty(window, "parent", { value: window, configurable: true });
});

describe("the map frame", () => {
  it("says hello, loads the provider's script it is told to, sending only the origin, and draws the scene", async () => {
    await start();
    expect(sent).toEqual([{ type: "hello" }]);
    await receive({ type: "load", map: KAKAO });
    expect(scripts().map((s) => [s.src, s.referrerPolicy])).toEqual([[KAKAO.sdkUrl, "strict-origin"]]);
    expect(sent).toEqual([{ type: "hello" }, { type: "ready" }]);

    await receive({ type: "draw", scene: SCENE, pickable: false });
    expect(live("marker").map((m) => [m.opts.title, m.opts.position.lat, m.opts.position.lng])).toEqual([["You", 37.4, 127.1]]);
    expect(live("circle").map((c) => c.opts.radius)).toEqual([100]);
    expect(live("line").map((l) => l.opts.path.length)).toEqual([2]);

    await receive({ type: "draw", scene: { ...SCENE, markers: [], lines: [] }, pickable: false });
    expect(live("marker")).toEqual([]);
    expect(live("line")).toEqual([]);
    expect(live("circle")).toHaveLength(1);

    await receive({ type: "load", map: NAVER });
    expect(scripts()).toHaveLength(1);
  });

  it("ignores anything but its own parent at this origin, and anything malformed", async () => {
    await start();
    await receive({ type: "load", map: KAKAO }, { source: window });
    await receive({ type: "load", map: KAKAO }, { origin: "https://evil.example" });
    await receive({ type: "load", map: { provider: "google", sdkUrl: KAKAO.sdkUrl } });
    await receive({ type: "load" });
    await receive("load");
    expect(scripts()).toEqual([]);
    expect(sent).toEqual([{ type: "hello" }]);

    await receive({ type: "load", map: KAKAO });
    await receive({ type: "draw", scene: { ...SCENE, markers: [{ id: "x", at: { lat: 91, lon: 0 }, title: "x" }] }, pickable: false });
    await receive({ type: "draw", scene: { ...SCENE, lines: [{ id: "x", points: [{ lat: "37", lon: 127 }] }] }, pickable: false });
    await receive({ type: "draw", scene: SCENE });
    expect(overlays).toEqual([]);
  });

  it("loads no script from outside the provider's own https origin", async () => {
    for (const sdkUrl of ["https://evil.example/sdk.js", "http://dapi.kakao.com/v2/maps/sdk.js", "https://oapi.map.naver.com/x.js", "not a url"]) {
      for (const [type, fn] of listeners.splice(0)) window.removeEventListener(type, fn);
      sent = [];
      await start();
      await receive({ type: "load", map: { provider: "kakao", sdkUrl } });
      expect(scripts(), sdkUrl).toEqual([]);
      expect(sent, sdkUrl).toEqual([{ type: "hello" }, { type: "failed", why: "blocked" }]);
    }
  });

  it("fails as `load` when the script does not load", async () => {
    happyDOM().settings.handleDisabledFileLoadingAsSuccess = false;
    await start();
    await receive({ type: "load", map: KAKAO });
    expect(sent).toEqual([{ type: "hello" }, { type: "failed", why: "load" }]);
    await receive({ type: "draw", scene: SCENE, pickable: false });
    expect(overlays).toEqual([]);
  });

  it("gives Kakao's script and its maps.load one time limit, and fails once when maps.load never calls back", async () => {
    kakaoLoads = false;
    await start();
    vi.useFakeTimers();
    window.dispatchEvent(new MessageEvent("message", { data: { type: "load", map: KAKAO }, source: parent as unknown as Window, origin: location.origin }));
    await vi.advanceTimersByTimeAsync(14_000);
    expect(scripts().map((s) => s.src)).toEqual([KAKAO.sdkUrl]);
    expect(sent).toEqual([{ type: "hello" }]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual([{ type: "hello" }, { type: "failed", why: "load" }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(2);
  });

  it("fails as `refused` when Naver refuses the key, even after the map was drawn", async () => {
    await start();
    await receive({ type: "load", map: NAVER });
    expect(sent.at(-1)).toEqual({ type: "ready" });
    (window as unknown as { navermap_authFailure: () => void }).navermap_authFailure();
    expect(sent.at(-1)).toEqual({ type: "failed", why: "refused" });
  });

  it("fails as `blocked` when the CSP blocks a script the map needs, but not for Kakao's eval probe or an image", async () => {
    await start();
    await receive({ type: "load", map: KAKAO });
    const violation = (effectiveDirective: string, blockedURI: string) =>
      window.dispatchEvent(Object.assign(new Event("securitypolicyviolation"), { effectiveDirective, blockedURI }));
    violation("script-src", "eval");
    violation("img-src", "https://static.naver.net/maps/mantle/1x/auth_fail.png");
    expect(sent).toEqual([{ type: "hello" }, { type: "ready" }]);
    violation("script-src-elem", "https://t1.kakaocdn.net/mapjsapi/js/main/4.5.29/kakao.js");
    violation("script-src-elem", "https://t1.kakaocdn.net/other.js");
    expect(sent).toEqual([{ type: "hello" }, { type: "ready" }, { type: "failed", why: "blocked" }]);
  });

  it("says where the map was clicked only while the scene is pickable", async () => {
    await start();
    await receive({ type: "load", map: KAKAO });
    const click = () => clicks[0]!({ latLng: { getLat: () => 37.1234567, getLng: () => 127.7654321 } });
    await receive({ type: "draw", scene: SCENE, pickable: false });
    click();
    expect(sent.filter((m) => m.type === "pick")).toEqual([]);
    await receive({ type: "draw", scene: SCENE, pickable: true });
    click();
    expect(sent.filter((m) => m.type === "pick")).toEqual([{ type: "pick", at: { lat: 37.1234567, lon: 127.7654321 } }]);
  });

  it("does nothing when opened on its own instead of framed", async () => {
    Object.defineProperty(window, "parent", { value: window, configurable: true });
    const posted = vi.spyOn(window, "postMessage");
    await start();
    await receive({ type: "load", map: KAKAO }, { source: window });
    expect(posted).not.toHaveBeenCalled();
    expect(scripts()).toEqual([]);
  });
});
