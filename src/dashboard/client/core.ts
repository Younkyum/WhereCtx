/**
 * /dashboard/core.js: state, translation, the API client (cookie session,
 * 401 -> sign-in, 403 reauth_required -> passkey step-up then one retry), the
 * WebAuthn calls, and small DOM helpers shared by every view.
 */

export const CORE_JS = String.raw`import { I18N } from './i18n.js';
import {
  ageParts, authenticationToJSON, creationOptionsFromJSON, errorKey, esc, passkeyErrorKey,
  registrationToJSON, requestOptionsFromJSON, statusKey
} from './lib.js';

var LANG_KEY = 'wherectx_lang';

function storedLang() {
  try { return localStorage.getItem(LANG_KEY); } catch (e) { return null; }
}

export var state = {
  lang: storedLang() || (String(navigator.language || 'en').slice(0, 2) === 'ko' ? 'ko' : 'en'),
  me: null
};

export function setLang(lang) {
  state.lang = lang;
  try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* private mode */ }
}

export function t(key, vars) {
  var table = I18N[state.lang] || I18N.en;
  var s = table[key] != null ? table[key] : (I18N.en[key] != null ? I18N.en[key] : key);
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, function (m, name) { return vars[name] == null ? m : String(vars[name]); });
}

export function $(sel, root) { return (root || document).querySelector(sel); }
export function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

var toastTimer = 0;
export function toast(msg, ok) {
  var el = $('#toast');
  el.textContent = msg;
  el.className = ok === false ? 'show err' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.className = ''; }, ok === false ? 4200 : 2400);
}

var signedOut = function () {};
export function onSignedOut(fn) { signedOut = fn; }

function apiError(status, data) {
  var e = new Error(data.error || ('HTTP ' + status));
  e.status = status;
  e.code = data.code || null;
  e.detail = data.detail;
  return e;
}

/**
 * Same-origin JSON call with the session cookie. A 401 without a code means
 * the session is gone (account refusals carry a code). opts.public marks the
 * sign-in calls, whose 401 is a wrong code, not a lost session.
 */
export async function api(path, opts) {
  opts = opts || {};
  var init = { method: opts.method || (opts.body === undefined ? 'GET' : 'POST'), credentials: 'same-origin', headers: {} };
  if (opts.body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  var res;
  try { res = await fetch(path, init); } catch (e) { throw apiError(0, { code: 'network' }); }
  var text = await res.text();
  var data = {};
  if (text) { try { data = JSON.parse(text); } catch (e) { data = {}; } }
  if (res.ok) return data;
  var err = apiError(res.status, data);
  if (res.status === 401 && !err.code && !opts.public) {
    err.handled = true;
    signedOut();
    throw err;
  }
  if (res.status === 403 && err.code === 'reauth_required' && !opts.retried) {
    await reauth();
    return api(path, Object.assign({}, opts, { retried: true }));
  }
  throw err;
}

export async function createPasskey(options) {
  var cred = await navigator.credentials.create({ publicKey: creationOptionsFromJSON(options) });
  return registrationToJSON(cred);
}

export async function getPasskey(options) {
  var cred = await navigator.credentials.get({ publicKey: requestOptionsFromJSON(options) });
  return authenticationToJSON(cred);
}

/** Prove a passkey again (step-up). The caller retries its request after this. */
export async function reauth() {
  toast(t('reauth.prompt'));
  var start = await api('/v1/me/reauth/options', { method: 'POST', retried: true });
  var response = await getPasskey(start.options);
  await api('/v1/me/reauth/verify', { body: { ceremony: start.ceremony, response: response }, retried: true });
}

export function describe(e) {
  var key = passkeyErrorKey(e) || errorKey(e);
  return key ? t(key) : ((e && e.message) || t('err.generic'));
}

export function fail(e) {
  if (e && e.handled) return;
  toast(describe(e), false);
}

export async function refreshMe() {
  state.me = await api('/v1/me');
  return state.me;
}

export function myId() { return state.me ? state.me.user.id : null; }

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('common.copied'));
  } catch (e) {
    toast(t('err.copy'), false);
  }
}

export function download(filename, text, type) {
  var url = URL.createObjectURL(new Blob([text], { type: type || 'application/json' }));
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

export function confirmed(key, vars) { return window.confirm(t(key || 'common.confirm', vars)); }

export function fmtTime(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(state.lang === 'ko' ? 'ko-KR' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtDate(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(state.lang === 'ko' ? 'ko-KR' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function ago(min) {
  var p = ageParts(min);
  return t(p[0], { n: p[1] });
}

export function statusLabel(status) { return t(statusKey(status)); }

/** Translated text, escaped for HTML. */
export function tx(key, vars) { return esc(t(key, vars)); }

export function pageHead(titleKey, descKey) {
  return '<header class="vhead"><h1>' + tx(titleKey) + '</h1>' + (descKey ? '<p>' + tx(descKey) + '</p>' : '') + '</header>';
}

export function panel(titleKey, body, cls) {
  return '<section class="panel' + (cls ? ' ' + cls : '') + '"><div class="phead"><span class="pdot"></span><h2 class="ptitle">' + tx(titleKey) + '</h2></div>' + body + '</section>';
}

export function emptyState(key) { return '<div class="empty">' + tx(key) + '</div>'; }

export function chip(text, cls) {
  return '<span class="chip' + (cls ? ' ' + cls : '') + '"><span class="dot"></span>' + esc(text) + '</span>';
}

/** One-time secret box with a copy button (data-act="copy" reads data-copy). */
export function secretBox(labelKey, value) {
  return '<div class="secret"><span class="lab">' + tx(labelKey) + '</span><code>' + esc(value) + '</code>'
    + '<button type="button" class="ghost sm" data-act="copy" data-copy="' + esc(value) + '">' + tx('common.copy') + '</button></div>';
}

function guard(el, fn) {
  if (el.getAttribute('data-busy')) return;
  el.setAttribute('data-busy', '1');
  var disable = 'disabled' in el && el.type !== 'checkbox';
  if (disable) el.disabled = true;
  Promise.resolve().then(fn).catch(fail).then(function () {
    el.removeAttribute('data-busy');
    if (disable) el.disabled = false;
  });
}

/**
 * Event delegation for a view: data-act (click), data-form (submit) and
 * data-change (change) name a handler. A handler's rejection is shown as a
 * toast; its element is disabled while it runs. "copy" is built in. An inner
 * bind() that handled the event (preventDefault) wins over an outer one.
 */
export function bind(root, handlers) {
  root.addEventListener('click', function (ev) {
    if (ev.defaultPrevented) return;
    var el = ev.target.closest('[data-act]');
    if (!el || !root.contains(el)) return;
    var name = el.getAttribute('data-act');
    if (name === 'copy') { ev.preventDefault(); copyText(el.getAttribute('data-copy') || ''); return; }
    var fn = handlers[name];
    if (!fn) return;
    ev.preventDefault();
    guard(el, function () { return fn(el); });
  });
  root.addEventListener('submit', function (ev) {
    if (ev.defaultPrevented) return;
    var form = ev.target;
    var fn = handlers[form.getAttribute('data-form')];
    if (!fn) return;
    ev.preventDefault();
    guard(form.querySelector('[type=submit]') || form, function () { return fn(form); });
  });
  root.addEventListener('change', function (ev) {
    var el = ev.target.closest('[data-change]');
    if (!el || !root.contains(el)) return;
    var fn = handlers[el.getAttribute('data-change')];
    if (!fn) return;
    guard(el, function () { return fn(el); });
  });
}

/** Run a loader; on failure show the error inside the target instead of a blank area. */
export async function load(target, fn) {
  try {
    await fn();
  } catch (e) {
    if (e && e.handled) return;
    target.innerHTML = '<div class="empty err">' + esc(describe(e)) + '</div>';
  }
}
`;
