/** What a map shows (MapView draws it), the view to fit, and the scene each page draws. */

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

export interface MapPolygon {
  id: string;
  ring: LatLon[];
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
  polygons: MapPolygon[];
  lines: MapLine[];
}

// ---- the view to fit ----

const M_PER_DEG_LAT = 111_320;

/** The view to fit: one point to center on, or the box around every marker, circle edge, polygon vertex and line point. */
export type Fit = { kind: "center"; at: LatLon } | { kind: "box"; sw: LatLon; ne: LatLon } | null;

export function fitOf(scene: MapScene): Fit {
  const points: LatLon[] = [...scene.markers.map((m) => m.at), ...scene.polygons.flatMap((p) => p.ring), ...scene.lines.flatMap((l) => l.points)];
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

export const EMPTY_SCENE: MapScene = { markers: [], circles: [], polygons: [], lines: [] };

/** A place as the API gives it: a circle, or a polygon's closed [lon, lat] ring with its centroid and circumradius. */
type PlaceLike = { name: string; lat: number; lon: number; radiusM: number; polygon?: Array<[number, number]> };

/** Each place as its own shape: a circle at its radius, a polygon along its ring. */
function placeShapes(places: readonly PlaceLike[]): Pick<MapScene, "circles" | "polygons"> {
  const circles: MapCircle[] = [];
  const polygons: MapPolygon[] = [];
  for (const p of places) {
    const id = `place:${p.name}`;
    if (p.polygon) polygons.push({ id, ring: p.polygon.map(([lon, lat]) => ({ lat, lon })), title: p.name });
    else circles.push({ id, at: { lat: p.lat, lon: p.lon }, radiusM: p.radiusM, title: p.name });
  }
  return { circles, polygons };
}

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
    ...placeShapes(me?.kind === "nearHome" ? [me.place] : []),
    markers: [
      ...(me?.kind === "point" ? [{ id: "me", at: me.at, title: me.title }] : []),
      ...opened.map((p) => ({ id: `person:${p.id}`, at: p.at, title: p.title })),
    ],
  };
}

/** History: the track as a line, the latest point marked, my places as their shapes. */
export function historyScene(points: readonly LatLon[], places: readonly PlaceLike[], latestTitle: string): MapScene {
  const last = points.at(-1);
  return {
    markers: last ? [{ id: "latest", at: { lat: last.lat, lon: last.lon }, title: latestTitle }] : [],
    ...placeShapes(places),
    lines: points.length > 1 ? [{ id: "track", points: points.map((p) => ({ lat: p.lat, lon: p.lon })) }] : [],
  };
}

/** Places: every place as its shape, and the point picked for a new one. */
export function placesScene(places: readonly PlaceLike[], picked: LatLon | null, pickedTitle: string): MapScene {
  return { ...EMPTY_SCENE, ...placeShapes(places), markers: picked ? [{ id: "picked", at: picked, title: pickedTitle }] : [] };
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
