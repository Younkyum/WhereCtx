/**
 * An interactive map of a scene, drawn in the page with the bundled Leaflet
 * (mapCanvas.ts) on the server's raster tiles. No maps key is involved: the
 * tile server sees only which areas a map shows and the browser's address.
 * With no tiles (MAP_TILE_URL=off, or the config cannot be read) no map is
 * made and `fallback` shows instead.
 */

import { VStack } from "@astryxdesign/core/Layout";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import type { MapCanvas, MapTiles } from "./mapCanvas";
import { useApp } from "./context";
import type { LatLon, MapScene } from "./mapScene";
import { Hint, Panel } from "./ui";

export type { MapTiles };

/** The tiles maps are drawn on; undefined while they load, null for no maps. */
export function useMapTiles(): MapTiles | null | undefined {
  const [tiles, setTiles] = useState<MapTiles | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void api<{ tiles: MapTiles | null }>("/v1/geo/map-config")
      .then((c) => c.tiles ?? null)
      .catch(() => null)
      .then((t) => live && setTiles(t));
    return () => {
      live = false;
    };
  }, []);
  return tiles;
}

/** The host a tile URL template names. */
export const tileHost = (url: string) => {
  try {
    return new URL(url.replace(/\{[a-z]+\}/g, "0")).host;
  } catch {
    return url;
  }
};

export function MapView({
  tiles,
  scene,
  fallback = null,
  title,
  hint,
  onPick,
  height = 320,
}: {
  /** From useMapTiles: nothing shows while it is undefined. */
  tiles: MapTiles | null | undefined;
  /** Memoize it: a new scene redraws the map and fits it again. */
  scene: MapScene;
  fallback?: ReactNode;
  /** Set the map in a panel with this title. */
  title?: string;
  /** A line under the map. */
  hint?: string;
  /** Called with the point clicked on the map. */
  onPick?: (at: LatLon) => void;
  height?: number;
}) {
  const { t } = useApp();
  const box = useRef<HTMLDivElement>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  const [tilesFailed, setTilesFailed] = useState(false);
  const pickable = onPick !== undefined;

  const [made, setMade] = useState<MapCanvas | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!tiles || !el) return;
    setTilesFailed(false);
    let canvas: MapCanvas | null = null;
    let live = true;
    // Leaflet is its own chunk, fetched from this origin only when a map is drawn.
    void import("./mapCanvas").then(({ createMapCanvas }) => {
      if (!live) return;
      canvas = createMapCanvas(el, tiles, (at) => pick.current?.(at), () => setTilesFailed(true));
      setMade(canvas);
    });
    return () => {
      live = false;
      canvas?.destroy();
      setMade(null);
    };
  }, [tiles]);

  useEffect(() => {
    made?.draw(scene, pickable);
  }, [made, scene, pickable]);

  if (tiles === undefined) return null;
  if (!tiles) return <>{fallback}</>;
  const notes = [hint, tilesFailed ? t("map.tilesFailed", { host: tileHost(tiles.url) }) : undefined].filter(Boolean) as string[];
  const map = (
    <VStack gap={2}>
      <div
        ref={box}
        role="region"
        aria-label={title ?? t("map.label")}
        style={{ width: "100%", height, borderRadius: 8, overflow: "hidden", background: "var(--color-background-muted)", isolation: "isolate" }}
      />
      {notes.map((n) => (
        <Hint key={n}>{n}</Hint>
      ))}
    </VStack>
  );
  return title ? <Panel title={title}>{map}</Panel> : map;
}
