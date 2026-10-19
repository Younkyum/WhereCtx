/**
 * A Leaflet map in an element, on the server's raster tiles (MAP_TILE_URL):
 * the only part of the dashboard that touches Leaflet. Leaflet is bundled,
 * so nothing but tile images is loaded from elsewhere, and each tile asks
 * with the dashboard's origin as its Referer, never the page's path.
 *
 * Every title and the attribution reach the page as text nodes, never HTML.
 */

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { fitOf, type Fit, type LatLon, type MapScene } from "./mapScene";

/** What GET /v1/geo/map-config answers in `tiles`. */
export interface MapTiles {
  url: string;
  attribution: string;
  attributionUrl: string | null;
}

export interface MapCanvas {
  draw(scene: MapScene, pickable: boolean): void;
  destroy(): void;
}

const STROKE = "#2563eb";
const SEOUL: L.LatLngTuple = [37.5665, 126.978];
const ll = (p: LatLon): L.LatLngTuple => [p.lat, p.lon];

function textNode(text: string): HTMLElement {
  const span = document.createElement("span");
  span.textContent = text;
  return span;
}

function attribution(tiles: MapTiles): HTMLElement {
  if (!tiles.attributionUrl) return textNode(tiles.attribution);
  const a = document.createElement("a");
  a.href = tiles.attributionUrl;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = tiles.attribution;
  return a;
}

/** A map in `el`. `onTileError` is called once, the first time a tile fails to load. */
export function createMapCanvas(el: HTMLElement, tiles: MapTiles, onPick: (at: LatLon) => void, onTileError: () => void): MapCanvas {
  const map = L.map(el, { center: SEOUL, zoom: 13, attributionControl: false });
  L.tileLayer(tiles.url, { maxZoom: 19, referrerPolicy: "strict-origin" })
    .once("tileerror", onTileError)
    .addTo(map);
  // Leaflet's own attribution control writes HTML; this one holds a text node.
  const credit = new L.Control({ position: "bottomright" });
  credit.onAdd = () => {
    const box = L.DomUtil.create("div", "leaflet-control-attribution");
    box.appendChild(attribution(tiles));
    return box;
  };
  credit.addTo(map);

  let pickable = false;
  map.on("click", (e: L.LeafletMouseEvent) => pickable && onPick({ lat: e.latlng.lat, lon: e.latlng.lng }));
  const overlays = L.layerGroup().addTo(map);

  let fit: Fit = null;
  const refit = () => {
    if (fit?.kind === "center") map.setView(ll(fit.at), 16, { animate: false });
    else if (fit) map.fitBounds([ll(fit.sw), ll(fit.ne)], { padding: [24, 24], maxZoom: 17, animate: false });
  };
  // The element is often laid out after the map is made, or resized with the page: measure again and fit the scene again.
  const resized = new ResizeObserver(() => {
    map.invalidateSize({ animate: false });
    refit();
  });
  resized.observe(el);

  return {
    draw(scene, canPick) {
      pickable = canPick;
      overlays.clearLayers();
      const stroke = { weight: 2, color: STROKE, opacity: 0.9 };
      for (const c of scene.circles) {
        L.circle(ll(c.at), { radius: c.radiusM, ...stroke, fillColor: STROKE, fillOpacity: 0.12 }).bindTooltip(textNode(c.title)).addTo(overlays);
      }
      for (const line of scene.lines) L.polyline(line.points.map(ll), { ...stroke, weight: 4, interactive: false }).addTo(overlays);
      for (const m of scene.markers) {
        L.circleMarker(ll(m.at), { radius: 7, color: "#ffffff", weight: 2, fillColor: STROKE, fillOpacity: 1 }).bindTooltip(textNode(m.title)).addTo(overlays);
      }
      fit = fitOf(scene);
      refit();
    },
    destroy() {
      resized.disconnect();
      map.remove();
    },
  };
}
