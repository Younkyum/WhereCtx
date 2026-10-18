/**
 * /dashboard/app.js: the entry module. Decides gate vs app from GET /v1/me,
 * owns navigation (a table of views drives the desktop rail, the phone tab
 * bar and the "more" sheet), the language toggle, and sign-out.
 */

export const APP_JS = String.raw`import { $, $$, api, fail, onSignedOut, setLang, state, t, toast, tx } from './core.js';
import { esc, parseInviteHash } from './lib.js';
import { renderInviteAccept, rerenderGate, startGate } from './gate.js';
import { render as renderHome } from './home.js';
import { render as renderSharing } from './sharing.js';
import { renderEvents, renderPlaces, renderPrivacy, renderWebhooks } from './data.js';
import { renderAgents, renderDevices } from './devices.js';
import { render as renderWorkspace, selectWorkspace } from './workspace.js';
import { onSignOut, render as renderAccount } from './account.js';

/** Every screen once: id (the URL hash), nav icon and label, renderer, and whether it gets a phone tab. */
var VIEWS = [
  { id: 'home', icon: '◉', label: 'nav.home', render: renderHome, tab: true },
  { id: 'sharing', icon: '⇄', label: 'nav.sharing', render: renderSharing, tab: true },
  { id: 'places', icon: '⌖', label: 'nav.places', render: renderPlaces, tab: true },
  { id: 'devices', icon: '▢', label: 'nav.devices', render: renderDevices, tab: true },
  { id: 'agents', icon: '✦', label: 'nav.agents', render: renderAgents },
  { id: 'privacy', icon: '⊘', label: 'nav.privacy', render: renderPrivacy },
  { id: 'workspace', icon: '⌂', label: 'nav.workspace', render: renderWorkspace },
  { id: 'account', icon: '◎', label: 'nav.account', render: renderAccount },
  { id: 'events', icon: '≡', label: 'nav.events', render: renderEvents },
  { id: 'webhooks', icon: '⇆', label: 'nav.webhooks', render: renderWebhooks }
];

var mode = 'loading';
var pendingInvite = null;
var cleanup = null;

function viewFor(id) { return VIEWS.filter(function (v) { return v.id === id; })[0] || null; }
function routeId() { var v = viewFor(location.hash.slice(1)); return v ? v.id : 'home'; }

function applyStatic() {
  document.documentElement.lang = state.lang;
  $$('[data-i18n]').forEach(function (el) { el.textContent = t(el.getAttribute('data-i18n')); });
  $$('[data-lang]').forEach(function (b) {
    var on = b.getAttribute('data-lang') === state.lang;
    b.className = on ? 'on' : '';
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function navLink(v, active) {
  return '<a href="#' + esc(v.id) + '"' + (v.id === active ? ' class="on" aria-current="page"' : '') + '><span class="ic" aria-hidden="true">' + v.icon + '</span><span>' + tx(v.label) + '</span></a>';
}

function renderNav(active) {
  $('#nav').innerHTML = VIEWS.map(function (v) { return navLink(v, active); }).join('');
  var tabs = VIEWS.filter(function (v) { return v.tab; });
  var inMore = !viewFor(active) || !viewFor(active).tab;
  $('#tabbar').innerHTML = tabs.map(function (v) { return navLink(v, active); }).join('')
    + '<button type="button" id="moreBtn" aria-expanded="false" aria-controls="more"' + (inMore ? ' class="on"' : '') + '><span class="ic" aria-hidden="true">⋯</span><span>' + tx('nav.more') + '</span></button>';
  $('#more').innerHTML = '<nav class="sheet-nav">' + VIEWS.filter(function (v) { return !v.tab; }).map(function (v) { return navLink(v, active); }).join('') + '</nav>';
  var me = state.me;
  $('#who').innerHTML = me ? '<span class="who-name">' + esc(me.user.displayName) + '</span>' : '';
}

function setMode(next) {
  mode = next;
  document.body.setAttribute('data-mode', next);
  $('#gate').className = next === 'gate' ? '' : 'hidden';
  $('#view').className = next === 'app' ? '' : 'hidden';
  closeMore();
}

function closeMore() {
  $('#more').className = 'sheet hidden';
  var b = $('#moreBtn');
  if (b) b.setAttribute('aria-expanded', 'false');
}

function show(id) {
  if (cleanup) { cleanup(); cleanup = null; }
  var v = viewFor(id) || VIEWS[0];
  renderNav(v.id);
  document.title = t(v.label) + ' · WhereCtx';
  var host = $('#view');
  var root = document.createElement('div');
  root.className = 'view';
  host.innerHTML = '';
  host.appendChild(root);
  var after = v.render(root);
  if (typeof after === 'function') cleanup = after;
  window.scrollTo(0, 0);
}

function enterApp() {
  setMode('app');
  if (pendingInvite) {
    var token = pendingInvite;
    pendingInvite = null;
    renderNav(null);
    renderInviteAccept($('#view'), token, function (next, wsId) {
      if (wsId) selectWorkspace(wsId);
      if (location.hash === '#' + next) show(next); else location.hash = '#' + next;
    });
    return;
  }
  show(routeId());
}

async function signedIn() {
  try {
    state.me = await api('/v1/me');
  } catch (e) { fail(e); return; }
  enterApp();
}

function enterGate() {
  if (cleanup) { cleanup(); cleanup = null; }
  state.me = null;
  setMode('gate');
  renderNav(null);
  document.title = 'WhereCtx';
  startGate($('#gate'), pendingInvite, signedIn);
}

async function signOut(callServer) {
  if (callServer) {
    try { await api('/v1/auth/logout', { method: 'POST', public: true }); } catch (e) { /* the cookie may already be gone */ }
  }
  toast(t('account.signedOut'));
  enterGate();
}

onSignedOut(function () {
  if (mode !== 'app') return;
  toast(t('err.sessionEnded'), false);
  enterGate();
});
onSignOut(signOut);

window.addEventListener('hashchange', function () {
  var invite = parseInviteHash(location.hash);
  if (invite) { consumeInvite(invite); if (mode === 'app') enterApp(); else enterGate(); return; }
  if (mode === 'app') show(routeId());
});

document.addEventListener('click', function (ev) {
  var lang = ev.target.closest('[data-lang]');
  if (lang) {
    setLang(lang.getAttribute('data-lang'));
    applyStatic();
    if (mode === 'app') show(routeId()); else if (mode === 'gate') rerenderGate();
    return;
  }
  if (ev.target.closest('#moreBtn')) {
    var open = $('#more').className.indexOf('hidden') >= 0;
    $('#more').className = open ? 'sheet' : 'sheet hidden';
    $('#moreBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
    return;
  }
  if (!ev.target.closest('#more .sheet-nav') || ev.target.closest('#more a')) closeMore();
});

/** Take the invite token out of the address bar so it is not bookmarked or shared by accident. */
function consumeInvite(token) {
  pendingInvite = token;
  history.replaceState(null, '', location.pathname + location.search);
}

async function boot() {
  applyStatic();
  var invite = parseInviteHash(location.hash);
  if (invite) consumeInvite(invite);
  try {
    state.me = await api('/v1/me', { public: true });
  } catch (e) {
    state.me = null;
  }
  if (state.me) enterApp(); else enterGate();
}

boot();
`;
