/**
 * The provider maps, behind one small surface: load a provider's script once
 * per page, then draw a scene (markers, circles, lines) on it. The script URL
 * and key come only from GET /v1/geo/map-config; with none, nothing here
 * runs and no provider is contacted.
 *
 * Each provider is one adapter in ADAPTERS. They differ only in their SDK's
 * names; what to show and where to look is decided by the pure functions
 * below them.
 */

import type { GeoProviderName } from "./model";

export interface LatLon {
  lat: number;
  lon: number;
}

export interface MapMarker {
  id: string;
  at: LatLon;
  title: string;
}

export interface MapCircle {
  id: string;
  at: LatLon;
  radiusM: number;
  title: string;
}

export interface MapLine {
  id: string;
  points: LatLon[];
}

/** Everything one map shows. */
export interface MapScene {
  markers: MapMarker[];
  circles: MapCircle[];
  lines: MapLine[];
}

/** What GET /v1/geo/map-config answers. */
export type MapConfig = { provider: GeoProviderName; sdkUrl: string; key: string } | { provider: null };

/** One drawn map: redraw it with a new scene, or take it down. */
export interface DrawnMap {
  draw(scene: MapScene): void;
  destroy(): void;
}

/**
 * What differs between the SDKs. Their overlay classes (Marker, Circle,
 * Polyline) take the same option names, so drawing is shared.
 */
interface MapAdapter {
  /** Resolves once the SDK's script has run and the map classes exist. */
  ready(): Promise<void>;
  maps(): any;
  newMap(maps: any, el: HTMLElement, center: any): any;
  onClick(maps: any, map: any, pick: (at: LatLon) => void): void;
  center(map: any, at: any): void;
  box(maps: any, map: any, sw: any, ne: any): void;
  destroy(map: any, el: HTMLElement): void;
}

const STROKE = "#2563eb";
const SEOUL: LatLon = { lat: 37.5665, lon: 126.978 };
const M_PER_DEG_LAT = 111_320;

/** The view to fit: one point to center on, or the box around every marker, circle edge and line point. */
export type Fit = { kind: "center"; at: LatLon } | { kind: "box"; sw: LatLon; ne: LatLon } | null;

export function fitOf(scene: MapScene): Fit {
  const points: LatLon[] = [...scene.markers.map((m) => m.at), ...scene.lines.flatMap((l) => l.points)];
  for (const c of scene.circles) {
    const dLat = c.radiusM / M_PER_DEG_LAT;
    const dLon = c.radiusM / (M_PER_DEG_LAT * Math.max(Math.cos((c.at.lat * Math.PI) / 180), 0.01));
    points.push({ lat: c.at.lat - dLat, lon: c.at.lon - dLon }, { lat: c.at.lat + dLat, lon: c.at.lon + dLon });
  }
  if (points.length === 0) return null;
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const sw = { lat: Math.min(...lats), lon: Math.min(...lons) };
  const ne = { lat: Math.max(...lats), lon: Math.max(...lons) };
  return sw.lat === ne.lat && sw.lon === ne.lon ? { kind: "center", at: sw } : { kind: "box", sw, ne };
}

// The SDKs' globals, typed as far as this file uses them.
type Overlay = { setMap(map: unknown): void };
type SdkWindow = Window & {
  kakao?: { maps: any };
  naver?: { maps: any };
  navermap_authFailure?: () => void;
};
const sdkWindow = () => window as SdkWindow;

const failureListeners = new Set<() => void>();

/** Called when a provider says the key was refused after its script loaded (Naver's key check). */
export function onMapRefused(listener: () => void): () => void {
  failureListeners.add(listener);
  return () => failureListeners.delete(listener);
}

const ADAPTERS: Record<GeoProviderName, MapAdapter> = {
  kakao: {
    ready() {
      const maps = sdkWindow().kakao?.maps;
      if (!maps?.load) return Promise.reject(new Error("the Kakao map script did not load"));
      return new Promise((resolve) => maps.load(resolve));
    },
    maps: () => sdkWindow().kakao!.maps,
    newMap: (maps, el, center) => new maps.Map(el, { center, level: 5 }),
    onClick: (maps, map, pick) => maps.event.addListener(map, "click", (e: any) => pick({ lat: e.latLng.getLat(), lon: e.latLng.getLng() })),
    center(map, at) {
      map.setCenter(at);
      map.setLevel(4);
    },
    box: (maps, map, sw, ne) => map.setBounds(new maps.LatLngBounds(sw, ne)),
    destroy: (_map, el) => el.replaceChildren(),
  },
  naver: {
    ready: () => (sdkWindow().naver?.maps ? Promise.resolve() : Promise.reject(new Error("the Naver map script did not load"))),
    maps: () => sdkWindow().naver!.maps,
    newMap: (maps, el, center) => new maps.Map(el, { center, zoom: 14 }),
    onClick: (maps, map, pick) => maps.Event.addListener(map, "click", (e: any) => pick({ lat: e.coord.lat(), lon: e.coord.lng() })),
    center(map, at) {
      map.setCenter(at);
      map.setZoom(16);
    },
    box: (maps, map, sw, ne) => map.fitBounds(new maps.LatLngBounds(sw, ne)),
    destroy: (map) => map.destroy(),
  },
};

/** Draw on a provider's map. */
function create(adapter: MapAdapter, el: HTMLElement, onPick?: (at: LatLon) => void): DrawnMap {
  const maps = adapter.maps();
  const ll = (p: LatLon) => new maps.LatLng(p.lat, p.lon);
  const map = adapter.newMap(maps, el, ll(SEOUL));
  if (onPick) adapter.onClick(maps, map, onPick);
  let overlays: Overlay[] = [];
  const clear = () => {
    for (const o of overlays) o.setMap(null);
    overlays = [];
  };
  return {
    draw(scene) {
      clear();
      const stroke = { strokeWeight: 2, strokeColor: STROKE, strokeOpacity: 0.9 };
      overlays = [
        ...scene.circles.map((c) => new maps.Circle({ map, center: ll(c.at), radius: c.radiusM, ...stroke, fillColor: STROKE, fillOpacity: 0.12 })),
        ...scene.lines.map((l) => new maps.Polyline({ map, path: l.points.map(ll), ...stroke, strokeWeight: 4 })),
        ...scene.markers.map((m) => new maps.Marker({ map, position: ll(m.at), title: m.title })),
      ];
      const fit = fitOf(scene);
      if (fit?.kind === "center") adapter.center(map, ll(fit.at));
      else if (fit) adapter.box(maps, map, ll(fit.sw), ll(fit.ne));
    },
    destroy() {
      clear();
      adapter.destroy(map, el);
    },
  };
}

const SCRIPT_TIMEOUT_MS = 15_000;

/** The one script this page loaded, by URL; a different URL (another person signed in since) is not loaded again. */
let loaded: { url: string; adapter: Promise<MapAdapter> } | null = null;

function inject(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    // The provider checks the key's registered domain; it gets the origin, never the path.
    script.referrerPolicy = "strict-origin";
    script.async = true;
    const timer = setTimeout(() => reject(new Error("the map script timed out")), SCRIPT_TIMEOUT_MS);
    script.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    script.onerror = () => {
      clearTimeout(timer);
      reject(new Error("the map script could not load"));
    };
    script.src = url;
    document.head.appendChild(script);
  });
}

/**
 * Load the provider's script for this config, once per page (later calls
 * share the first load), and answer how to make a map on it.
 */
export async function loadMap(config: Exclude<MapConfig, { provider: null }>): Promise<(el: HTMLElement, onPick?: (at: LatLon) => void) => DrawnMap> {
  if (!loaded) {
    const adapter = ADAPTERS[config.provider];
    if (config.provider === "naver") sdkWindow().navermap_authFailure = () => failureListeners.forEach((f) => f());
    loaded = { url: config.sdkUrl, adapter: inject(config.sdkUrl).then(() => adapter.ready()).then(() => adapter) };
  }
  if (loaded.url !== config.sdkUrl) throw new Error("another map was loaded on this page");
  const adapter = await loaded.adapter;
  return (el, onPick) => create(adapter, el, onPick);
}

// ---- the scenes each view draws ----

export const EMPTY_SCENE: MapScene = { markers: [], circles: [], lines: [] };

const placeCircles = (places: readonly { name: string; lat: number; lon: number; radiusM: number }[]): MapCircle[] =>
  places.map((p) => ({ id: `place:${p.name}`, at: { lat: p.lat, lon: p.lon }, radiusM: p.radiusM, title: p.name }));

/** Home: me where I am, and each person whose exact location I opened (and only those). */
export function homeScene(me: { at: LatLon; title: string } | null, opened: readonly { id: string; at: LatLon; title: string }[]): MapScene {
  return {
    ...EMPTY_SCENE,
    markers: [...(me ? [{ id: "me", ...me }] : []), ...opened.map((p) => ({ id: `person:${p.id}`, at: p.at, title: p.title }))],
  };
}

/** History: the track as a line, the latest point marked, my places as circles. */
export function historyScene(points: readonly LatLon[], places: Parameters<typeof placeCircles>[0], latestTitle: string): MapScene {
  const last = points.at(-1);
  return {
    markers: last ? [{ id: "latest", at: { lat: last.lat, lon: last.lon }, title: latestTitle }] : [],
    circles: placeCircles(places),
    lines: points.length > 1 ? [{ id: "track", points: points.map((p) => ({ lat: p.lat, lon: p.lon })) }] : [],
  };
}

/** Places: every place as its circle, and the point picked for a new one. */
export function placesScene(places: Parameters<typeof placeCircles>[0], picked: LatLon | null, pickedTitle: string): MapScene {
  return { ...EMPTY_SCENE, circles: placeCircles(places), markers: picked ? [{ id: "picked", at: picked, title: pickedTitle }] : [] };
}

/** A route: its line, with the start and the destination marked. */
export function routeScene(path: readonly LatLon[], destination: string, startTitle: string): MapScene {
  const [first, last] = [path[0], path.at(-1)];
  return {
    ...EMPTY_SCENE,
    lines: path.length > 1 ? [{ id: "route", points: [...path] }] : [],
    markers: first && last ? [{ id: "start", at: first, title: startTitle }, { id: "end", at: last, title: destination }] : [],
  };
}
