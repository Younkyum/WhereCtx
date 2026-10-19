/**
 * An interactive map of a scene, from the provider my map key is for. It asks
 * the server for my map config first; with none (no map key, maps off) it
 * shows `fallback` and the provider is never contacted. If the script fails,
 * or the provider refuses the key, it shows `fallback` with a note.
 */

import { VStack } from "@astryxdesign/core/Layout";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import { useApp } from "./context";
import { loadMap, onMapRefused, type DrawnMap, type LatLon, type MapConfig, type MapScene } from "./mapSdk";
import { Hint, Panel } from "./ui";

type MapState = "loading" | "none" | "ready" | "failed";

export function MapView({
  scene,
  fallback = null,
  title,
  hint,
  onPick,
  height = 320,
}: {
  /** Memoize it: a new scene redraws the map and fits it again. */
  scene: MapScene;
  fallback?: ReactNode;
  /** Set the map in a panel with this title. */
  title?: string;
  /** A line under the map, shown only with the map. */
  hint?: string;
  /** Called with the point clicked on the map. */
  onPick?: (at: LatLon) => void;
  height?: number;
}) {
  const { t } = useApp();
  const [state, setState] = useState<MapState>("loading");
  const el = useRef<HTMLDivElement>(null);
  const drawn = useRef<DrawnMap | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  const pickable = onPick !== undefined;

  useEffect(() => {
    let live = true;
    const off = onMapRefused(() => live && setState("failed"));
    void (async () => {
      const config = await api<MapConfig>("/v1/geo/map-config").catch((): MapConfig => ({ provider: null }));
      if (!live) return;
      if (!config.provider) return setState("none");
      try {
        const make = await loadMap(config);
        if (!live || !el.current) return;
        drawn.current = make(el.current, pickable ? (at) => pick.current?.(at) : undefined);
        setState("ready");
      } catch {
        if (live) setState("failed");
      }
    })();
    return () => {
      live = false;
      off();
      drawn.current?.destroy();
      drawn.current = null;
    };
  }, [pickable]);

  useEffect(() => {
    if (state === "ready") drawn.current?.draw(scene);
  }, [state, scene]);

  if (state === "none") return <>{fallback}</>;
  if (state === "failed") {
    return (
      <>
        {fallback}
        <Hint>{t("map.failed")}</Hint>
      </>
    );
  }
  const box = (
    <div
      ref={el}
      role="region"
      aria-label={title ?? t("map.label")}
      aria-busy={state === "loading"}
      style={{ width: "100%", height, borderRadius: 8, overflow: "hidden", background: "var(--color-background-muted)" }}
    />
  );
  const map = hint ? (
    <VStack gap={2}>
      {box}
      <Hint>{hint}</Hint>
    </VStack>
  ) : (
    box
  );
  return title ? <Panel title={title}>{map}</Panel> : map;
}
