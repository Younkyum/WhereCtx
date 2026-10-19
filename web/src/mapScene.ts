/**
 * What a map shows, and the messages the dashboard and its map frame
 * (map.html, mapFrame.ts) exchange. The dashboard never loads a provider's
 * script itself: it frames /dashboard/map.html, the one page whose CSP allows
 * the providers' hosts, and tells it which script to load and what to draw.
 * Both sides parse every message they receive with the functions here.
 */

import { SDK_ORIGINS } from "../../src/geo/mapSdk";
import { GEO_PROVIDERS, type GeoProviderName } from "./model";

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

/** What GET /v1/geo/map-config answers: the provider's script, with the map key in its URL, or no map. */
export type MapConfig = { provider: GeoProviderName; sdkUrl: string } | { provider: null };
export type LoadableMap = Extract<MapConfig, { provider: GeoProviderName }>;

/** A script URL is loaded only from its provider's own origin, over https. */
export function sdkUrlAllowed(config: LoadableMap): boolean {
  try {
    const url = new URL(config.sdkUrl);
    return url.protocol === "https:" && url.origin === SDK_ORIGINS[config.provider];
  } catch {
    return false;
  }
}

/**
 * Why a map did not load. refused: the provider refused the key after its
 * script ran (Naver's key check). blocked: this page's CSP blocked a script
 * the map needs, or the server named a script from elsewhere. load: the
 * script failed or did not answer in time; for Kakao a refused key looks the
 * same, since its loader answers 401.
 */
export const MAP_FAILURES = ["refused", "blocked", "load"] as const;
export type MapFailure = (typeof MAP_FAILURES)[number];

/** Dashboard to frame. */
export type ToFrame = { type: "load"; map: LoadableMap } | { type: "draw"; scene: MapScene; pickable: boolean };

/** Frame to dashboard. hello: the frame is listening. pick: a click on the map, when the scene is pickable. */
export type FromFrame = { type: "hello" } | { type: "ready" } | { type: "failed"; why: MapFailure } | { type: "pick"; at: LatLon };

// ---- parsing what arrives in a message ----

const MAX_ITEMS = 5000;
const MAX_TEXT = 200;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length <= MAX_TEXT;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function latLon(v: unknown): LatLon | null {
  if (!isObj(v) || !finite(v.lat) || !finite(v.lon) || Math.abs(v.lat) > 90 || Math.abs(v.lon) > 180) return null;
  return { lat: v.lat, lon: v.lon };
}

function list<T>(v: unknown, item: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(v) || v.length > MAX_ITEMS) return null;
  const out: T[] = [];
  for (const x of v) {
    const parsed = item(x);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

const marker = (v: unknown): MapMarker | null => {
  const at = isObj(v) ? latLon(v.at) : null;
  return at && isObj(v) && text(v.id) && text(v.title) ? { id: v.id, at, title: v.title } : null;
};
const circle = (v: unknown): MapCircle | null => {
  const at = isObj(v) ? latLon(v.at) : null;
  return at && isObj(v) && text(v.id) && text(v.title) && finite(v.radiusM) && v.radiusM > 0 && v.radiusM <= 100_000
    ? { id: v.id, at, radiusM: v.radiusM, title: v.title }
    : null;
};
const line = (v: unknown): MapLine | null => {
  const points = isObj(v) ? list(v.points, latLon) : null;
  return points && isObj(v) && text(v.id) ? { id: v.id, points } : null;
};

function scene(v: unknown): MapScene | null {
  if (!isObj(v)) return null;
  const markers = list(v.markers, marker);
  const circles = list(v.circles, circle);
  const lines = list(v.lines, line);
  return markers && circles && lines ? { markers, circles, lines } : null;
}

export function parseToFrame(data: unknown): ToFrame | null {
  if (!isObj(data)) return null;
  if (data.type === "load" && isObj(data.map)) {
    const { provider, sdkUrl } = data.map;
    if (!GEO_PROVIDERS.includes(provider as GeoProviderName) || typeof sdkUrl !== "string") return null;
    return { type: "load", map: { provider: provider as GeoProviderName, sdkUrl } };
  }
  if (data.type === "draw" && typeof data.pickable === "boolean") {
    const parsed = scene(data.scene);
    return parsed && { type: "draw", scene: parsed, pickable: data.pickable };
  }
  return null;
}

export function parseFromFrame(data: unknown): FromFrame | null {
  if (!isObj(data)) return null;
  if (data.type === "hello" || data.type === "ready") return { type: data.type };
  if (data.type === "failed" && MAP_FAILURES.includes(data.why as MapFailure)) return { type: "failed", why: data.why as MapFailure };
  if (data.type === "pick") {
    const at = latLon(data.at);
    return at && { type: "pick", at };
  }
  return null;
}

// ---- the view to fit ----

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

// ---- the scenes each view draws ----

export const EMPTY_SCENE: MapScene = { markers: [], circles: [], lines: [] };

type PlaceLike = { name: string; lat: number; lon: number; radiusM: number };
const placeCircles = (places: readonly PlaceLike[]): MapCircle[] =>
  places.map((p) => ({ id: `place:${p.name}`, at: { lat: p.lat, lon: p.lon }, radiusM: p.radiusM, title: p.name }));

/**
 * Home: me, and each person whose exact location I opened (and only those).
 * Me is my point, or, while I am near home and the provider is kept away
 * from there, my home place's circle and no point.
 */
export function homeScene(
  me: { kind: "point"; at: LatLon; title: string } | { kind: "nearHome"; place: PlaceLike } | null,
  opened: readonly { id: string; at: LatLon; title: string }[],
): MapScene {
  return {
    ...EMPTY_SCENE,
    circles: me?.kind === "nearHome" ? placeCircles([me.place]) : [],
    markers: [
      ...(me?.kind === "point" ? [{ id: "me", at: me.at, title: me.title }] : []),
      ...opened.map((p) => ({ id: `person:${p.id}`, at: p.at, title: p.title })),
    ],
  };
}

/** History: the track as a line, the latest point marked, my places as circles. */
export function historyScene(points: readonly LatLon[], places: readonly PlaceLike[], latestTitle: string): MapScene {
  const last = points.at(-1);
  return {
    markers: last ? [{ id: "latest", at: { lat: last.lat, lon: last.lon }, title: latestTitle }] : [],
    circles: placeCircles(places),
    lines: points.length > 1 ? [{ id: "track", points: points.map((p) => ({ lat: p.lat, lon: p.lon })) }] : [],
  };
}

/** Places: every place as its circle, and the point picked for a new one. */
export function placesScene(places: readonly PlaceLike[], picked: LatLon | null, pickedTitle: string): MapScene {
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
