/**
 * Ready-to-use client configuration for a freshly minted token: the MCP entry
 * an agent client pastes, and what a phone needs to start sending location.
 * Pure builders; the secret is embedded because each result is shown exactly
 * once, in the response that minted the token.
 *
 * OwnTracks facts relied on (booklet, checked 2026-10):
 * - `_type: "configuration"` keys `mode` (3 = HTTP), `url`, `auth`, `username`,
 *   `password`, `deviceId`, `tid`, `monitoring`, `locatorDisplacement`,
 *   `locatorInterval`: https://owntracks.org/booklet/tech/json/
 * - HTTP mode authenticates with HTTP Basic from `username`/`password`:
 *   https://owntracks.org/booklet/tech/http/
 * - `owntracks:///config?inline=<base64 of the .otrc JSON>` imports a config:
 *   https://owntracks.org/booklet/features/remoteconfig/
 * - Monitoring 1 ("significant changes") is the battery-friendly mode; on
 *   Android it honours locatorDisplacement (default 500 m) and locatorInterval:
 *   https://owntracks.org/booklet/features/location/
 * - In that mode a phone at rest reports nothing; iOS still sends a `t: "p"`
 *   ping "once in a while", and Android a ping every `ping` minutes (Android
 *   only, https://owntracks.org/booklet/tech/json/; the minutes and the
 *   default of 15 are from the app's Scheduler.kt and DefaultsProvider.kt).
 *   The ping is what tells a quiet phone from an offline one.
 */

import QRCode from "qrcode";

export const DEVICE_KINDS = ["owntracks", "shortcut"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * Why a phone could not use a config built on `baseUrl`, or null. A loopback
 * host is the phone itself, and plain http would carry the device token in
 * the clear; either way the pairing would mint a token that never works.
 */
export function pairingBaseUrlProblem(baseUrl: string): string | null {
  const url = new URL(baseUrl);
  if (isLoopback(url.hostname)) {
    return `BASE_URL (${baseUrl}) points at this server's own machine, which a phone cannot reach. Set BASE_URL to the server's public https URL.`;
  }
  if (url.protocol !== "https:") {
    return `BASE_URL (${baseUrl}) is not https, so the phone would send its token in the clear. Set BASE_URL to the server's public https URL.`;
  }
  return null;
}

/** Claude Desktop's remote-server entry, as in examples/claude-desktop/config.json. */
export function mcpClientConfig(baseUrl: string, secret: string) {
  return {
    mcpServers: {
      wherectx: {
        url: `${baseUrl}/mcp`,
        headers: { Authorization: `Bearer ${secret}` },
      },
    },
  };
}

/** OwnTracks monitoring mode 1: significant location changes. */
const SIGNIFICANT_CHANGES = 1;
const HTTP_MODE = 3;

/** A deviceId OwnTracks can show and topic-build from: lowercase, [a-z0-9-]. */
export function deviceIdFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "phone";
}

/** The two-character tracker id OwnTracks draws on the map. */
export function trackerIdFor(name: string): string {
  const letters = name.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return (letters + "WC").slice(0, 2);
}

/**
 * The token travels as the Basic password (the server ignores the username),
 * so it stays out of the URL and therefore out of proxy access logs.
 */
export function ownTracksConfig(baseUrl: string, name: string, secret: string) {
  const deviceId = deviceIdFor(name);
  return {
    _type: "configuration",
    mode: HTTP_MODE,
    url: `${baseUrl}/v1/ingest/owntracks`,
    auth: true,
    username: deviceId,
    password: secret,
    deviceId,
    tid: trackerIdFor(name),
    monitoring: SIGNIFICANT_CHANGES,
    locatorDisplacement: 500,
    locatorInterval: 300,
    // Android: a heartbeat every 15 minutes (its default, set so it is not lost).
    ping: 15,
  };
}

/**
 * The import link. Standard base64 can contain `+`, `/` and `=`, so it is
 * percent-encoded to survive the query string (a `+` left bare may be read as
 * a space); the booklet does not say, so this relies on the apps decoding
 * query values as URL parsers do.
 */
export function ownTracksLink(config: object): string {
  const encoded = Buffer.from(JSON.stringify(config), "utf8").toString("base64");
  return `owntracks:///config?inline=${encodeURIComponent(encoded)}`;
}

/** An SVG QR code of `text`, rendered server-side. */
export function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
}

export async function ownTracksPairing(baseUrl: string, name: string, secret: string) {
  const config = ownTracksConfig(baseUrl, name, secret);
  const link = ownTracksLink(config);
  return { kind: "owntracks" as const, config, link, qrSvg: await qrSvg(link) };
}

/** Matches clients/ios-shortcut/README.md: the token goes in a Bearer header. */
export function shortcutPairing(baseUrl: string, secret: string) {
  return {
    kind: "shortcut" as const,
    url: `${baseUrl}/v1/ingest/shortcut`,
    token: secret,
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
  };
}
