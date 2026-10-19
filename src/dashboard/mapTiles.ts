/**
 * The raster tiles the dashboard's maps are drawn on. The map code (Leaflet)
 * is bundled with the dashboard, so the only thing a map loads from
 * elsewhere is tile images, from the one origin MAP_TILE_URL names; the CSP's
 * img-src allows exactly that origin and nothing else (app/securityHeaders.ts).
 *
 * The default is OpenStreetMap's own tile server, which asks for a visible
 * attribution, a valid Referer, and light, interactive use only
 * (https://operations.osmfoundation.org/policies/tiles/). A server with many
 * people should point MAP_TILE_URL at its own or a paid tile server.
 */

export interface MapTiles {
  /** A Leaflet URL template: https, with {z}, {x} and {y}, optionally {r}. */
  url: string;
  /** The origin every tile comes from. */
  origin: string;
  /** Plain text, shown on every map. */
  attribution: string;
  /** Where the attribution links to, or null for no link. */
  attributionUrl: string | null;
}

export const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";
export const OSM_ATTRIBUTION_URL = "https://www.openstreetmap.org/copyright";

const PLACEHOLDER = /\{([a-z]+)\}/g;
const ALLOWED = new Set(["z", "x", "y", "r"]);
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/;
const ATTRIBUTION_MAX = 200;

function httpsUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an https URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error(`${name} must be an https URL without credentials`);
  return url;
}

/**
 * The tiles to draw maps on, or null when MAP_TILE_URL is `off`. Throws on a
 * template that is not https, names its host with a placeholder (one origin
 * only, so no {s}), or lacks {z}, {x} or {y}.
 */
export function parseMapTiles(input: { url: string; attribution: string; attributionUrl: string }): MapTiles | null {
  if (input.url === "off") return null;
  const names = [...input.url.matchAll(PLACEHOLDER)].map((m) => m[1]!);
  const unknown = names.filter((n) => !ALLOWED.has(n));
  if (unknown.length) throw new Error(`MAP_TILE_URL may use only {z}, {x}, {y} and {r}, not {${unknown.join("}, {")}}`);
  if (!["z", "x", "y"].every((n) => names.includes(n))) throw new Error("MAP_TILE_URL must contain {z}, {x} and {y}");
  const filled = input.url.replace(PLACEHOLDER, "0");
  const url = httpsUrl(filled, "MAP_TILE_URL");
  if (!input.url.toLowerCase().includes(`//${url.host}`)) throw new Error("MAP_TILE_URL must name one host, with no placeholder in it");

  const attribution = input.attribution.trim();
  if (!attribution || attribution.length > ATTRIBUTION_MAX || UNPRINTABLE.test(attribution)) {
    throw new Error(`MAP_TILE_ATTRIBUTION must be 1 to ${ATTRIBUTION_MAX} printable characters`);
  }
  const link = input.attributionUrl.trim();
  return {
    url: input.url,
    origin: url.origin,
    attribution,
    attributionUrl: link === "off" ? null : httpsUrl(link, "MAP_TILE_ATTRIBUTION_URL").href,
  };
}
