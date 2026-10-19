/**
 * An interactive map of a scene, from the provider my map key is for. The
 * provider's script never runs in this page: the map is a frame of
 * /dashboard/map.html (mapFrame.ts), the one page whose CSP allows the
 * provider's hosts, and this side only tells it what to load and draw. With
 * no map config (no map key, maps off) the frame is never made and the
 * provider is never contacted; `fallback` shows instead. If the map fails, it
 * shows `fallback` with a note that says why.
 */

import { VStack } from "@astryxdesign/core/Layout";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import { useApp } from "./context";
import { parseFromFrame, sdkUrlAllowed, type LatLon, type MapConfig, type MapFailure, type MapScene, type ToFrame } from "./mapScene";
import { Hint, Panel } from "./ui";

/** My map config; undefined while it loads, and no map when it cannot be read. */
export function useMapConfig(): MapConfig | undefined {
  const [config, setConfig] = useState<MapConfig | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void api<MapConfig>("/v1/geo/map-config")
      .catch((): MapConfig => ({ provider: null }))
      .then((c) => live && setConfig(c));
    return () => {
      live = false;
    };
  }, []);
  return config;
}

/** Script URLs whose key the provider refused on this page; a later map with one falls back at once. */
const refused = new Set<string>();

const FRAME_URL = `${import.meta.env.BASE_URL}map.html`;

type MapState = { kind: "loading" } | { kind: "ready" } | { kind: "failed"; why: MapFailure };

export function MapView({
  config,
  scene,
  fallback = null,
  title,
  hint,
  onPick,
  height = 320,
}: {
  /** From useMapConfig: nothing shows while it is undefined. */
  config: MapConfig | undefined;
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
  const [state, setState] = useState<MapState>({ kind: "loading" });
  const frame = useRef<HTMLIFrameElement>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  const pickable = onPick !== undefined;
  const provider = config?.provider ?? null;
  const sdkUrl = config?.provider ? config.sdkUrl : null;

  useEffect(() => {
    if (!provider || !sdkUrl) return;
    const map = { provider, sdkUrl };
    if (!sdkUrlAllowed(map)) return setState({ kind: "failed", why: "blocked" });
    if (refused.has(sdkUrl)) return setState({ kind: "failed", why: "refused" });
    setState({ kind: "loading" });
    const post = (message: ToFrame) => frame.current?.contentWindow?.postMessage(message, location.origin);
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow || e.origin !== location.origin) return;
      const message = parseFromFrame(e.data);
      if (message?.type === "hello") post({ type: "load", map });
      if (message?.type === "ready") setState({ kind: "ready" });
      if (message?.type === "pick") pick.current?.(message.at);
      if (message?.type === "failed") {
        if (message.why === "refused") refused.add(sdkUrl);
        setState({ kind: "failed", why: message.why });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [provider, sdkUrl]);

  useEffect(() => {
    if (state.kind === "ready") frame.current?.contentWindow?.postMessage({ type: "draw", scene, pickable } satisfies ToFrame, location.origin);
  }, [state, scene, pickable]);

  if (!config) return null;
  if (!config.provider) return <>{fallback}</>;
  if (state.kind === "failed") {
    return (
      <>
        {fallback}
        <Hint>{t(`map.failed.${state.why}`, { provider: t(`maps.p.${config.provider}`) })}</Hint>
      </>
    );
  }
  const box = (
    <iframe
      ref={frame}
      src={FRAME_URL}
      title={title ?? t("map.label")}
      aria-busy={state.kind === "loading"}
      style={{ display: "block", width: "100%", height, border: 0, borderRadius: 8, background: "var(--color-background-muted)" }}
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
