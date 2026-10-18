/**
 * /dashboard/lib.js: the dashboard's pure helpers (no DOM). Escaping, base64url
 * and the WebAuthn JSON <-> ArrayBuffer conversions, role rules, labels. Tests
 * import this exact served text as a module (dashboard.test.ts).
 *
 * Authored as a string so `tsc` alone builds the dashboard: no backticks and
 * no template placeholders inside the script; the role tables are filled in
 * from the server's registry so the two never drift.
 */

import { MANAGEABLE_ROLES, ROLE_PERMISSIONS, WORKSPACE_ROLES } from "../../accounts/types.js";

const roleTable = (table: Record<string, ReadonlySet<string>>): string =>
  JSON.stringify(Object.fromEntries(Object.entries(table).map(([k, v]) => [k, [...v]])));

export const LIB_JS = String.raw`export var ROLES = ${JSON.stringify(WORKSPACE_ROLES)};
export var ROLE_PERMISSIONS = ${roleTable(ROLE_PERMISSIONS)};
export var MANAGEABLE_ROLES = ${roleTable(MANAGEABLE_ROLES)};
export var STATUSES = ['home', 'near_home', 'away', 'work', 'near_work', 'transit', 'custom', 'unknown'];

var ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Text for HTML text or a double-quoted attribute. Every server value goes through it. */
export function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return ESCAPES[c]; });
}

export function b64urlToBytes(text) {
  var b64 = String(text).replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  var bin = atob(b64);
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(data) {
  var bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  var bin = '';
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function withIds(list) {
  return (list || []).map(function (c) { return Object.assign({}, c, { id: b64urlToBytes(c.id) }); });
}

/** Server registration options (JSON) -> navigator.credentials.create({ publicKey }). */
export function creationOptionsFromJSON(o) {
  return Object.assign({}, o, {
    challenge: b64urlToBytes(o.challenge),
    user: Object.assign({}, o.user, { id: b64urlToBytes(o.user.id) }),
    excludeCredentials: withIds(o.excludeCredentials)
  });
}

/** Server authentication options (JSON) -> navigator.credentials.get({ publicKey }). */
export function requestOptionsFromJSON(o) {
  return Object.assign({}, o, {
    challenge: b64urlToBytes(o.challenge),
    allowCredentials: withIds(o.allowCredentials)
  });
}

function credentialBase(cred) {
  var out = {
    id: cred.id,
    rawId: bytesToB64url(cred.rawId),
    type: cred.type,
    clientExtensionResults: typeof cred.getClientExtensionResults === 'function' ? cred.getClientExtensionResults() : {}
  };
  if (cred.authenticatorAttachment) out.authenticatorAttachment = cred.authenticatorAttachment;
  return out;
}

/** A created PublicKeyCredential -> RegistrationResponseJSON. */
export function registrationToJSON(cred) {
  var r = cred.response;
  var out = credentialBase(cred);
  out.response = {
    clientDataJSON: bytesToB64url(r.clientDataJSON),
    attestationObject: bytesToB64url(r.attestationObject)
  };
  if (typeof r.getTransports === 'function') out.response.transports = r.getTransports();
  if (typeof r.getAuthenticatorData === 'function') out.response.authenticatorData = bytesToB64url(r.getAuthenticatorData());
  if (typeof r.getPublicKey === 'function') {
    var key = r.getPublicKey();
    if (key) out.response.publicKey = bytesToB64url(key);
  }
  if (typeof r.getPublicKeyAlgorithm === 'function') out.response.publicKeyAlgorithm = r.getPublicKeyAlgorithm();
  return out;
}

/** An asserted PublicKeyCredential -> AuthenticationResponseJSON. */
export function authenticationToJSON(cred) {
  var r = cred.response;
  var out = credentialBase(cred);
  out.response = {
    clientDataJSON: bytesToB64url(r.clientDataJSON),
    authenticatorData: bytesToB64url(r.authenticatorData),
    signature: bytesToB64url(r.signature)
  };
  if (r.userHandle && r.userHandle.byteLength) out.response.userHandle = bytesToB64url(r.userHandle);
  return out;
}

/** Why passkeys cannot work on this page: 'insecure' (http off localhost), 'unsupported', or null. */
export function webauthnProblem(win) {
  if (!win.isSecureContext) return 'insecure';
  if (!win.PublicKeyCredential || !win.navigator || !win.navigator.credentials) return 'unsupported';
  return null;
}

/** The invite token in a '#invite=<token>' fragment, or null. */
export function parseInviteHash(hash) {
  var m = /^#invite=(.+)$/.exec(hash || '');
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch (e) { return null; }
}

/** [i18n key, n] for an age in whole minutes. */
export function ageParts(min) {
  var m = Math.max(0, Math.floor(Number(min) || 0));
  if (m < 1) return ['age.now', 0];
  if (m < 60) return ['age.min', m];
  if (m < 1440) return ['age.hour', Math.floor(m / 60)];
  return ['age.day', Math.floor(m / 1440)];
}

export function statusKey(status) {
  return 'st.' + (STATUSES.indexOf(status) >= 0 ? status : 'unknown');
}

var CODE_KEYS = {
  reauth_required: 'err.reauth',
  last_owner: 'err.lastOwner',
  last_passkey: 'err.lastPasskey',
  gone: 'err.gone',
  conflict: 'err.conflict',
  forbidden: 'err.forbidden',
  not_found: 'err.notFound',
  unauthorized: 'err.unauthorized',
  invalid: 'err.invalid',
  base_url_unusable: 'err.baseUrl',
  network: 'err.network'
};

/** The i18n key for an API error ({ status, code }), or null to show its message. */
export function errorKey(err) {
  if (!err) return 'err.generic';
  if (err.code && CODE_KEYS[err.code]) return CODE_KEYS[err.code];
  if (err.status === 429) return 'err.rateLimited';
  if (err.status === 400) return 'err.invalid';
  if (err.status === 403) return 'err.forbidden';
  if (err.status === 404) return 'err.notFound';
  if (err.status >= 500) return 'err.server';
  return null;
}

/** The i18n key for a DOMException from navigator.credentials, or null. */
export function passkeyErrorKey(e) {
  var name = e && e.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return 'err.passkeyCancelled';
  if (name === 'InvalidStateError') return 'err.passkeyExists';
  if (name === 'SecurityError') return 'err.insecure';
  if (name === 'NotSupportedError') return 'err.unsupported';
  return null;
}

/** The i18n key for a GeolocationPositionError code. */
export function geoErrorKey(code) {
  if (code === 1) return 'geo.denied';
  if (code === 3) return 'geo.timeout';
  return 'geo.unavailable';
}

/** Only http(s) URLs become links; any other scheme is dropped. */
export function safeHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || '')) ? String(url) : '';
}

/** A short device name from a user agent, for passkey and session labels. */
export function deviceLabel(ua) {
  var s = String(ua || '');
  if (/iPhone/.test(s)) return 'iPhone';
  if (/iPad/.test(s)) return 'iPad';
  if (/Android/.test(s)) return 'Android';
  if (/Macintosh|Mac OS X/.test(s)) return 'Mac';
  if (/Windows/.test(s)) return 'Windows';
  if (/CrOS/.test(s)) return 'ChromeOS';
  if (/Linux/.test(s)) return 'Linux';
  return '';
}

export function can(role, action) {
  return (ROLE_PERMISSIONS[role] || []).indexOf(action) >= 0;
}

export function canManage(actor, target) {
  return (MANAGEABLE_ROLES[actor] || []).indexOf(target) >= 0;
}

/** What I may do to one member row, mirroring the server's role registry. */
export function memberActions(myRole, myId, member) {
  var self = member.userId === myId;
  var manage = !self && canManage(myRole, member.role);
  return {
    self: self,
    changeRole: manage && can(myRole, 'changeRole'),
    remove: manage && can(myRole, 'removeMember'),
    roleChoices: manage && can(myRole, 'changeRole') ? MANAGEABLE_ROLES[myRole].slice() : []
  };
}

/** Roles I may invite to a workspace where I hold myRole. */
export function inviteRoles(myRole) {
  return can(myRole, 'invite') ? MANAGEABLE_ROLES[myRole].slice() : [];
}
`;
