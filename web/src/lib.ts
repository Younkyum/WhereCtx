/**
 * The dashboard's pure helpers: base64url and the WebAuthn JSON <-> buffer
 * conversions, role rules (the server's own registry, imported), and the
 * mappings from API values and errors to i18n keys.
 */

import { MANAGEABLE_ROLES, can, canManage, type WorkspaceRole } from "../../src/accounts/types";
import type { I18nKey } from "./i18n";
import { MOTIONS, STATUSES, oneOf, type Member, type Motion, type Status } from "./model";

export function b64urlToBytes(text: string): Uint8Array<ArrayBuffer> {
  let b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(data: ArrayBuffer | ArrayBufferView): string {
  const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type CredentialDescriptorJSON = { id: string; type: string; transports?: string[] };

export interface CreationOptionsJSON {
  challenge: string;
  user: { id: string; name: string; displayName: string };
  excludeCredentials?: CredentialDescriptorJSON[];
  [key: string]: unknown;
}

export interface RequestOptionsJSON {
  challenge: string;
  allowCredentials?: CredentialDescriptorJSON[];
  [key: string]: unknown;
}

const withIds = (list: CredentialDescriptorJSON[] | undefined) =>
  (list ?? []).map((c) => ({ ...c, id: b64urlToBytes(c.id) }));

/** Server registration options (JSON) -> navigator.credentials.create({ publicKey }). */
export function creationOptionsFromJSON(o: CreationOptionsJSON): PublicKeyCredentialCreationOptions {
  return {
    ...o,
    challenge: b64urlToBytes(o.challenge),
    user: { ...o.user, id: b64urlToBytes(o.user.id) },
    excludeCredentials: withIds(o.excludeCredentials),
  } as unknown as PublicKeyCredentialCreationOptions;
}

/** Server authentication options (JSON) -> navigator.credentials.get({ publicKey }). */
export function requestOptionsFromJSON(o: RequestOptionsJSON): PublicKeyCredentialRequestOptions {
  return {
    ...o,
    challenge: b64urlToBytes(o.challenge),
    allowCredentials: withIds(o.allowCredentials),
  } as unknown as PublicKeyCredentialRequestOptions;
}

/** The parts of a PublicKeyCredential the conversions read; browsers and test doubles both fit. */
export interface CredentialLike {
  id: string;
  rawId: ArrayBuffer;
  type: string;
  authenticatorAttachment?: string | null;
  getClientExtensionResults?: () => unknown;
  response: {
    clientDataJSON: ArrayBuffer;
    attestationObject?: ArrayBuffer;
    authenticatorData?: ArrayBuffer;
    signature?: ArrayBuffer;
    userHandle?: ArrayBuffer | null;
    getTransports?: () => string[];
    getAuthenticatorData?: () => ArrayBuffer;
    getPublicKey?: () => ArrayBuffer | null;
    getPublicKeyAlgorithm?: () => number;
  };
}

type CredentialJSON = {
  id: string;
  rawId: string;
  type: string;
  clientExtensionResults: unknown;
  authenticatorAttachment?: string;
  response: Record<string, unknown>;
};

function credentialBase(cred: CredentialLike): Omit<CredentialJSON, "response"> {
  const out: Omit<CredentialJSON, "response"> = {
    id: cred.id,
    rawId: bytesToB64url(cred.rawId),
    type: cred.type,
    clientExtensionResults: typeof cred.getClientExtensionResults === "function" ? cred.getClientExtensionResults() : {},
  };
  if (cred.authenticatorAttachment) out.authenticatorAttachment = cred.authenticatorAttachment;
  return out;
}

/** A created PublicKeyCredential -> RegistrationResponseJSON. */
export function registrationToJSON(cred: CredentialLike): CredentialJSON {
  const r = cred.response;
  const response: Record<string, unknown> = {
    clientDataJSON: bytesToB64url(r.clientDataJSON),
    attestationObject: bytesToB64url(r.attestationObject ?? new ArrayBuffer(0)),
  };
  if (typeof r.getTransports === "function") response.transports = r.getTransports();
  if (typeof r.getAuthenticatorData === "function") response.authenticatorData = bytesToB64url(r.getAuthenticatorData());
  if (typeof r.getPublicKey === "function") {
    const key = r.getPublicKey();
    if (key) response.publicKey = bytesToB64url(key);
  }
  if (typeof r.getPublicKeyAlgorithm === "function") response.publicKeyAlgorithm = r.getPublicKeyAlgorithm();
  return { ...credentialBase(cred), response };
}

/** An asserted PublicKeyCredential -> AuthenticationResponseJSON. */
export function authenticationToJSON(cred: CredentialLike): CredentialJSON {
  const r = cred.response;
  const response: Record<string, unknown> = {
    clientDataJSON: bytesToB64url(r.clientDataJSON),
    authenticatorData: bytesToB64url(r.authenticatorData ?? new ArrayBuffer(0)),
    signature: bytesToB64url(r.signature ?? new ArrayBuffer(0)),
  };
  if (r.userHandle && r.userHandle.byteLength) response.userHandle = bytesToB64url(r.userHandle);
  return { ...credentialBase(cred), response };
}

/**
 * Why passkeys cannot work on this page, or null when they can. WebAuthn
 * rejects an IP-address host even when the page is a secure context, as
 * http://127.0.0.1 is. The URL parser normalizes IPv4 to dotted decimal and
 * brackets IPv6, so two shapes cover every IP literal.
 */
export function webauthnProblem(win: {
  isSecureContext: boolean;
  location: { hostname: string };
  PublicKeyCredential?: unknown;
  navigator?: { credentials?: unknown };
}): "ip-host" | "insecure" | "unsupported" | null {
  const host = win.location.hostname;
  if (host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return "ip-host";
  if (!win.isSecureContext) return "insecure";
  if (!win.PublicKeyCredential || !win.navigator?.credentials) return "unsupported";
  return null;
}

/** The invite token in a '#invite=<token>' fragment, or null. */
export function parseInviteHash(hash: string): string | null {
  const m = /^#invite=(.+)$/.exec(hash);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}

/** [i18n key, n] for an age in whole minutes. */
export function ageParts(min: number): [I18nKey, number] {
  const m = Math.max(0, Math.floor(Number(min) || 0));
  if (m < 1) return ["age.now", 0];
  if (m < 60) return ["age.min", m];
  if (m < 1440) return ["age.hour", Math.floor(m / 60)];
  return ["age.day", Math.floor(m / 1440)];
}

export function statusOf(value: unknown): Status {
  return oneOf(STATUSES, value) ? value : "unknown";
}

export function motionOf(value: unknown): Motion | null {
  return oneOf(MOTIONS, value) ? value : null;
}

/** What the API said went wrong: HTTP status, refusal code, and message. */
export interface ApiErrorInfo {
  status: number;
  code: string | null;
  message: string;
}

const CODE_KEYS: Record<string, I18nKey> = {
  reauth_required: "err.reauth",
  last_owner: "err.lastOwner",
  last_passkey: "err.lastPasskey",
  gone: "err.gone",
  conflict: "err.conflict",
  forbidden: "err.forbidden",
  not_found: "err.notFound",
  unauthorized: "err.unauthorized",
  invalid: "err.invalid",
  base_url_unusable: "err.baseUrl",
  network: "err.network",
};

/** The i18n key for an API error, or null to show the server's message. */
export function errorKey(err: ApiErrorInfo): I18nKey | null {
  if (err.code && Object.hasOwn(CODE_KEYS, err.code)) return CODE_KEYS[err.code]!;
  if (err.status === 429) return "err.rateLimited";
  if (err.status === 400) return "err.invalid";
  if (err.status === 403) return "err.forbidden";
  if (err.status === 404) return "err.notFound";
  if (err.status >= 500) return "err.server";
  return null;
}

/** The i18n key for a DOMException from navigator.credentials, or null. */
export function passkeyErrorKey(e: unknown): I18nKey | null {
  const name = e instanceof Error || (typeof e === "object" && e !== null) ? (e as { name?: unknown }).name : undefined;
  if (name === "NotAllowedError" || name === "AbortError") return "err.passkeyCancelled";
  if (name === "InvalidStateError") return "err.passkeyExists";
  if (name === "SecurityError") return "err.insecure";
  if (name === "NotSupportedError") return "err.unsupported";
  return null;
}

/** The i18n key for a GeolocationPositionError code. */
export function geoErrorKey(code: number | undefined): I18nKey {
  if (code === 1) return "geo.denied";
  if (code === 3) return "geo.timeout";
  return "geo.unavailable";
}

/** Only http(s) URLs become links; any other scheme is dropped. */
export function safeHttpUrl(url: unknown): string {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : "";
}

/** A short device name from a user agent, for passkey and session labels. */
export function deviceLabel(ua: string | null | undefined): string {
  const s = ua ?? "";
  if (/iPhone/.test(s)) return "iPhone";
  if (/iPad/.test(s)) return "iPad";
  if (/Android/.test(s)) return "Android";
  if (/Macintosh|Mac OS X/.test(s)) return "Mac";
  if (/Windows/.test(s)) return "Windows";
  if (/CrOS/.test(s)) return "ChromeOS";
  if (/Linux/.test(s)) return "Linux";
  return "";
}

/** What I may do to one member row, mirroring the server's role registry. */
export function memberActions(myRole: WorkspaceRole, myId: string, member: Member) {
  const self = member.userId === myId;
  const manage = !self && canManage(myRole, member.role);
  const changeRole = manage && can(myRole, "changeRole");
  return {
    self,
    changeRole,
    remove: manage && can(myRole, "removeMember"),
    roleChoices: changeRole ? [...MANAGEABLE_ROLES[myRole]] : [],
  };
}

/** Roles I may invite to a workspace where I hold myRole. */
export function inviteRoles(myRole: WorkspaceRole): WorkspaceRole[] {
  return can(myRole, "invite") ? [...MANAGEABLE_ROLES[myRole]] : [];
}

export interface QrDrawing {
  viewBox: string;
  paths: { d: string; fill?: string; stroke?: string }[];
}

const SAFE_PAINT = /^(#[0-9a-f]{3,8}|none|currentColor)$/i;
const SAFE_PATH = /^[MmHhVvLlZz0-9.,\s-]+$/;
const SAFE_VIEWBOX = /^[0-9.\s-]+$/;

/**
 * Reads the server's pairing QR code (an <svg> of <path>s) into plain data, so
 * the page draws it with React elements instead of inserting markup. Anything
 * beyond a viewBox and path geometry and paint is dropped; an unexpected
 * document yields null.
 */
export function qrFromSvg(svg: unknown): QrDrawing | null {
  if (typeof svg !== "string") return null;
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  if (root.nodeName !== "svg" || doc.getElementsByTagName("parsererror").length) return null;
  const viewBox = root.getAttribute("viewBox") ?? "";
  if (!SAFE_VIEWBOX.test(viewBox)) return null;
  const paths: QrDrawing["paths"] = [];
  for (const el of Array.from(root.getElementsByTagName("path"))) {
    const d = el.getAttribute("d") ?? "";
    if (!SAFE_PATH.test(d)) return null;
    const fill = el.getAttribute("fill");
    const stroke = el.getAttribute("stroke");
    paths.push({
      d,
      ...(fill && SAFE_PAINT.test(fill) ? { fill } : {}),
      ...(stroke && SAFE_PAINT.test(stroke) ? { stroke } : {}),
    });
  }
  return paths.length ? { viewBox, paths } : null;
}

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface TrackDrawing {
  width: number;
  height: number;
  /** SVG path data for the polyline, oldest point first. */
  line: string;
  dots: { x: number; y: number }[];
  places: { x: number; y: number; r: number; name: string }[];
}

const M_PER_DEG = 111_320;
/** A track that never moved still shows about this much ground (meters). */
const MIN_SPAN_M = 300;

/**
 * Lays a day's points out for an inline SVG: an equirectangular projection
 * around the track's mean latitude, fitted to the points' bounds with
 * `pad` pixels to spare. Places become circles at their geofence radius,
 * clipped by the SVG where they reach past the track.
 */
export function drawTrack(
  points: readonly GeoPoint[],
  places: readonly (GeoPoint & { radiusM: number; name: string })[],
  size: { width: number; height: number; pad: number } = { width: 640, height: 360, pad: 20 },
): TrackDrawing | null {
  if (points.length === 0) return null;
  const meanLat = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
  const kx = Math.cos((meanLat * Math.PI) / 180);
  const project = (p: GeoPoint) => ({ x: p.lon * kx, y: -p.lat });
  const xy = points.map(project);
  const xs = xy.map((p) => p.x);
  const ys = xy.map((p) => p.y);
  const minSpan = MIN_SPAN_M / M_PER_DEG;
  const spanX = Math.max(Math.max(...xs) - Math.min(...xs), minSpan);
  const spanY = Math.max(Math.max(...ys) - Math.min(...ys), minSpan);
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
  const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  const scale = Math.min((size.width - 2 * size.pad) / spanX, (size.height - 2 * size.pad) / spanY);
  const toScreen = (p: { x: number; y: number }) => ({
    x: round(size.width / 2 + (p.x - cx) * scale),
    y: round(size.height / 2 + (p.y - cy) * scale),
  });
  const dots = xy.map(toScreen);
  return {
    width: size.width,
    height: size.height,
    line: dots.map((d, i) => `${i === 0 ? "M" : "L"}${d.x} ${d.y}`).join(" "),
    dots,
    places: places.map((place) => ({
      ...toScreen(project(place)),
      r: round((place.radiusM / M_PER_DEG) * scale),
      name: place.name,
    })),
  };
}

const round = (n: number) => Math.round(n * 10) / 10;

/** Local calendar day of an ISO time, as YYYY-MM-DD. */
export function localDay(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** [start, end] of a local calendar day (YYYY-MM-DD), as ISO times for the API. */
export function dayRange(day: string): { from: string; to: string } {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const start = new Date(y, m - 1, d);
  const end = new Date(y, m - 1, d + 1);
  return { from: start.toISOString(), to: new Date(end.getTime() - 1).toISOString() };
}

/** The day before or after a YYYY-MM-DD day. */
export function shiftDay(day: string, by: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return localDay(new Date(y, m - 1, d + by));
}

/** Items grouped by their local day, keeping order. */
export function groupByDay<T>(items: readonly T[], timeOf: (item: T) => string): { day: string; items: T[] }[] {
  const groups: { day: string; items: T[] }[] = [];
  for (const item of items) {
    const day = localDay(timeOf(item));
    const last = groups.at(-1);
    if (last?.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
}
