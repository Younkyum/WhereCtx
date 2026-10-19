/**
 * The map frame: the script of /dashboard/map.html, the only page whose CSP
 * allows a map provider's hosts. The dashboard frames it per map, tells it
 * which provider's script to load, and sends it a scene to draw; it answers
 * when the map is ready, why it failed, and where the map was clicked. It
 * talks only to the dashboard that framed it (same origin, its parent
 * window), and the provider's script dies with the frame when the map goes.
 *
 * Each provider is one adapter in ADAPTERS. Their overlay classes (Marker,
 * Circle, Polyline) take the same option names, so drawing is shared.
 */

import { fitOf, parseToFrame, sdkUrlAllowed, type FromFrame, type LatLon, type LoadableMap, type MapFailure, type MapScene } from "./mapScene";
import type { GeoProviderName } from "./model";

/** The provider's script and its own readiness (Kakao's `maps.load`) share this one limit. */
export const LOAD_TIMEOUT_MS = 15_000;

const STROKE = "#2563eb";
const SEOUL: LatLon = { lat: 37.5665, lon: 126.978 };

type SdkWindow = Window & { kakao?: { maps: any }; naver?: { maps: any }; navermap_authFailure?: () => void };

interface MapAdapter {
  /** Resolves once the SDK's script has run and the map classes exist. */
  ready(win: SdkWindow): Promise<void>;
  maps(win: SdkWindow): any;
  newMap(maps: any, el: HTMLElement, center: any): any;
  onClick(maps: any, map: any, pick: (at: LatLon) => void): void;
  center(map: any, at: any): void;
  box(maps: any, map: any, sw: any, ne: any): void;
}

const ADAPTERS: Record<GeoProviderName, MapAdapter> = {
  kakao: {
    ready(win) {
      const maps = win.kakao?.maps;
      if (!maps?.load) return Promise.reject(new Error("the Kakao map script did not load"));
      return new Promise((resolve) => maps.load(resolve));
    },
    maps: (win) => win.kakao!.maps,
    newMap: (maps, el, center) => new maps.Map(el, { center, level: 5 }),
    onClick: (maps, map, pick) => maps.event.addListener(map, "click", (e: any) => pick({ lat: e.latLng.getLat(), lon: e.latLng.getLng() })),
    center(map, at) {
      map.setCenter(at);
      map.setLevel(4);
    },
    box: (maps, map, sw, ne) => map.setBounds(new maps.LatLngBounds(sw, ne)),
  },
  naver: {
    ready: (win) => (win.naver?.maps ? Promise.resolve() : Promise.reject(new Error("the Naver map script did not load"))),
    maps: (win) => win.naver!.maps,
    newMap: (maps, el, center) => new maps.Map(el, { center, zoom: 14 }),
    onClick: (maps, map, pick) => maps.Event.addListener(map, "click", (e: any) => pick({ lat: e.coord.lat(), lon: e.coord.lng() })),
    center(map, at) {
      map.setCenter(at);
      map.setZoom(16);
    },
    box: (maps, map, sw, ne) => map.fitBounds(new maps.LatLngBounds(sw, ne)),
  },
};

function inject(doc: Document, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = doc.createElement("script");
    // The provider checks the key's registered domain; it gets the origin, never the path.
    script.referrerPolicy = "strict-origin";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("the map script could not load"));
    script.src = url;
    doc.head.appendChild(script);
  });
}

function withTimeout<T>(win: Window, work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = win.setTimeout(() => reject(new Error("the map did not load in time")), ms);
    work.then(
      (value) => {
        win.clearTimeout(timer);
        resolve(value);
      },
      (e: unknown) => {
        win.clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** A drawn map: draw a scene on it, fitted to the scene. */
function create(win: SdkWindow, adapter: MapAdapter, el: HTMLElement, onClick: (at: LatLon) => void): (scene: MapScene) => void {
  const maps = adapter.maps(win);
  const ll = (p: LatLon) => new maps.LatLng(p.lat, p.lon);
  const map = adapter.newMap(maps, el, ll(SEOUL));
  adapter.onClick(maps, map, onClick);
  let overlays: { setMap(map: unknown): void }[] = [];
  return (scene) => {
    for (const o of overlays) o.setMap(null);
    const stroke = { strokeWeight: 2, strokeColor: STROKE, strokeOpacity: 0.9 };
    overlays = [
      ...scene.circles.map((c) => new maps.Circle({ map, center: ll(c.at), radius: c.radiusM, ...stroke, fillColor: STROKE, fillOpacity: 0.12 })),
      ...scene.lines.map((l) => new maps.Polyline({ map, path: l.points.map(ll), ...stroke, strokeWeight: 4 })),
      ...scene.markers.map((m) => new maps.Marker({ map, position: ll(m.at), title: m.title })),
    ];
    const fit = fitOf(scene);
    if (fit?.kind === "center") adapter.center(map, ll(fit.at));
    else if (fit) adapter.box(maps, map, ll(fit.sw), ll(fit.ne));
  };
}

type FrameState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; draw: (scene: MapScene) => void }
  | { kind: "failed" };

/** Answer the dashboard that framed this page; a page opened on its own does nothing. */
export function startMapFrame(win: SdkWindow): void {
  if (win.parent === win) return;
  const origin = win.location.origin;
  const post = (message: FromFrame) => win.parent.postMessage(message, origin);
  let state: FrameState = { kind: "idle" };
  let pickable = false;

  const fail = (why: MapFailure) => {
    if (state.kind === "failed") return;
    state = { kind: "failed" };
    post({ type: "failed", why });
  };

  // A script the map needs was blocked. Kakao's old-IE eval probe is
  // blocked too, inside a try, and is not a failure.
  win.addEventListener("securitypolicyviolation", (e) => {
    if ((e.effectiveDirective === "script-src-elem" || e.effectiveDirective === "script-src") && /^https?:/.test(e.blockedURI)) fail("blocked");
  });

  const load = (map: LoadableMap) => {
    if (!sdkUrlAllowed(map)) return fail("blocked");
    state = { kind: "loading" };
    const adapter = ADAPTERS[map.provider];
    if (map.provider === "naver") win.navermap_authFailure = () => fail("refused");
    withTimeout(win, inject(win.document, map.sdkUrl).then(() => adapter.ready(win)), LOAD_TIMEOUT_MS).then(
      () => {
        if (state.kind !== "loading") return;
        const el = win.document.getElementById("map")!;
        state = { kind: "ready", draw: create(win, adapter, el, (at) => pickable && post({ type: "pick", at })) };
        post({ type: "ready" });
      },
      () => fail("load"),
    );
  };

  win.addEventListener("message", (e) => {
    if (e.source !== win.parent || e.origin !== origin) return;
    const message = parseToFrame(e.data);
    if (message?.type === "load" && state.kind === "idle") load(message.map);
    if (message?.type === "draw" && state.kind === "ready") {
      pickable = message.pickable;
      state.draw(message.scene);
    }
  });
  post({ type: "hello" });
}

startMapFrame(window);
