/**
 * The interactive map each provider serves to a browser: the key kind it
 * takes, its script URL, and every host that script loads from, by CSP
 * directive. Only the dashboard's map frame (/dashboard/map.html) opens its
 * CSP to these hosts (app/securityHeaders.ts); every other page stays strict.
 *
 * Hosts were read from the SDKs themselves on 2026-10-19 (Kakao loader
 * 4.5.29, Naver Maps v3 3.10.4). Neither needs 'unsafe-eval': Kakao's one
 * eval is an old-IE probe inside a try, and Naver has none. Naver's error
 * telemetry (kr-col-ext.nelo.navercorp.com) and traffic layer
 * (map.pstatic.net) are left out on purpose.
 */

import type { GeoProviderName } from "./types.js";

export interface MapSdk {
  /** The key kind in a person's key bag (GEO_KEY_KINDS) that loads the map. */
  keyKind: "jsKey" | "mapKeyId";
  sdkUrl(key: string): string;
  scriptSrc: readonly string[];
  imgSrc: readonly string[];
  connectSrc: readonly string[];
}

/** Where each provider's script is served from: the dashboard loads a script only from its provider's origin. */
export const SDK_ORIGINS: Readonly<Record<GeoProviderName, string>> = {
  kakao: "https://dapi.kakao.com",
  naver: "https://oapi.map.naver.com",
};

export const MAP_SDKS: Readonly<Record<GeoProviderName, MapSdk>> = {
  kakao: {
    keyKind: "jsKey",
    sdkUrl: (key) => `${SDK_ORIGINS.kakao}/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&autoload=false`,
    // The loader, then the map code it appends.
    scriptSrc: ["https://dapi.kakao.com", "https://t1.kakaocdn.net"],
    // Map tiles; the marker and logo images.
    imgSrc: ["https://mts.kakaocdn.net", "https://t1.kakaocdn.net"],
    connectSrc: [],
  },
  naver: {
    keyKind: "mapKeyId",
    sdkUrl: (key) => `${SDK_ORIGINS.naver}/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(key)}`,
    // The SDK and its key check (JSONP), then the tile style metadata (JSONP).
    scriptSrc: ["https://oapi.map.naver.com", "https://nrbe.pstatic.net"],
    // Map tiles; the logo and blank tile.
    imgSrc: ["https://nrbe.pstatic.net", "https://ssl.pstatic.net"],
    // The clickable-label data beside each tile.
    connectSrc: ["https://nrbe.pstatic.net"],
  },
};

/** A map key goes into a script URL: letters, digits, `-` and `_` only. */
export const MAP_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/** What the dashboard is told to load: a provider's script (the key is in its URL), or no map. */
export type MapConfig = { provider: GeoProviderName; sdkUrl: string } | { provider: null };
