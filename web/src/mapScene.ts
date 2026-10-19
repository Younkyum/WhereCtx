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

export interface MapLine {
  id: string;
  points: LatLon[];
  /** Drawn dashed: a stretch on foot. */
  dashed?: boolean;
}

/** Everything one map shows. */
export interface MapScene {
  markers: MapMarker[];
  circles: MapCircle[];
  lines: MapLine[];
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
export function routeScene(
  route: { path: readonly LatLon[]; legs?: readonly { kind: string; path: readonly LatLon[] }[] },
  destination: string,
  startTitle: string,
): MapScene {
  const { path, legs } = route;
  const [first, last] = [path[0], path.at(-1)];
  const lines: MapLine[] = legs?.length
    ? legs.flatMap((leg, i) => (leg.path.length > 1 ? [{ id: `leg:${i}`, points: [...leg.path], dashed: leg.kind === "walk" }] : []))
    : path.length > 1
      ? [{ id: "route", points: [...path] }]
      : [];
  return {
    ...EMPTY_SCENE,
    lines,
    markers: first && last ? [{ id: "start", at: first, title: startTitle }, { id: "end", at: last, title: destination }] : [],
  };
}
