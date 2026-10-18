/**
 * /dashboard/home.js: my status card, "share my location now" (one browser
 * geolocation fix posted as a manual reading), and the people who share with
 * me, Find My style. Opening someone's exact location is audited on their side.
 */

export const HOME_JS = String.raw`import { ago, api, bind, chip, emptyState, load, pageHead, panel, statusLabel, t, toast, tx } from './core.js';
import { esc, geoErrorKey, safeHttpUrl } from './lib.js';

var MOTION_KEYS = ['stationary', 'walking', 'running', 'driving', 'transit'];

function motionChip(motion) {
  return MOTION_KEYS.indexOf(motion) >= 0 ? chip(t('motion.' + motion)) : '';
}

export function render(root) {
  root.innerHTML = pageHead('home.title')
    + '<section class="readout" id="mine"><div class="empty">' + tx('common.loading') + '</div></section>'
    + panel('people.title', '<div class="people" id="people"><div class="empty">' + tx('common.loading') + '</div></div>', 'flush');
  var mine = root.querySelector('#mine');
  var people = root.querySelector('#people');
  bind(root, {
    shareNow: async function () {
      var pos = await locate();
      var body = {
        source: 'manual',
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracyM: Math.round(pos.coords.accuracy),
        timestamp: new Date(pos.timestamp).toISOString()
      };
      var r = await api('/v1/ingest', { body: body });
      toast(t('home.shared', { status: statusLabel(r.status) }));
      await load(mine, function () { return loadMine(mine); });
    },
    precise: async function (el) {
      var id = el.getAttribute('data-id');
      var out = root.querySelector('[data-precise-for="' + CSS.escape(id) + '"]');
      var r = await api('/v1/people/' + encodeURIComponent(id));
      out.innerHTML = preciseBlock(r.person);
    }
  });
  load(mine, function () { return loadMine(mine); });
  load(people, function () { return loadPeople(people); });
  var timer = setInterval(function () { load(people, function () { return loadPeople(people); }); }, 30000);
  return function () { clearInterval(timer); };
}

function locate() {
  return new Promise(function (resolve, reject) {
    if (!navigator.geolocation) { reject(new Error(t('geo.unavailable'))); return; }
    navigator.geolocation.getCurrentPosition(resolve, function (e) { reject(new Error(t(geoErrorKey(e && e.code)))); },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  });
}

async function loadMine(box) {
  var privacy = await api('/v1/privacy');
  var paused = privacy.settings && privacy.settings.sharingPaused;
  var p = null;
  var problem = '';
  try {
    p = await api('/v1/presence');
  } catch (e) {
    if (e.status === 404) problem = t('home.none');
    else if (e.status === 403) problem = t('home.hiddenFromAgents');
    else throw e;
  }
  var badges = '';
  if (p) {
    badges += p.stale ? chip(t('badge.stale'), 'warn') : chip(t('badge.fresh'), 'ok');
    badges += motionChip(p.motion);
  }
  if (paused) badges += chip(t('badge.pausedAll'), 'warn');
  box.innerHTML = '<div class="rd-main"><div class="micro">' + tx('home.mine') + '</div>'
    + '<div class="status">' + esc(p ? statusLabel(p.status) : '—') + '</div>'
    + '<div class="meta">' + esc(p ? t('home.updated', { age: ago(Math.floor(p.updatedAgoSec / 60)) }) : problem) + '</div>'
    + '<div class="badges">' + badges + '</div></div>'
    + '<div class="rd-actions"><button type="button" class="btn" data-act="shareNow">' + tx('home.shareNow') + '</button>'
    + '<p class="hint">' + tx(paused ? 'home.shareNowPaused' : 'home.shareNowHint') + '</p></div>';
}

function initial(name) {
  var s = String(name || '?').trim();
  return s ? Array.from(s)[0].toUpperCase() : '?';
}

function personBody(p) {
  if (p.paused) return '<div class="pstatus muted">' + tx('people.paused') + '</div>';
  if (!p.presence) return '<div class="pstatus muted">' + tx('people.noReading') + '</div>';
  var pr = p.presence;
  var badges = (pr.stale ? chip(t('badge.stale'), 'warn') : '') + motionChip(pr.motion);
  if (p.precise === 'available') badges += chip(t('badge.preciseAvailable'), 'ok');
  return '<div class="pstatus">' + esc(statusLabel(pr.status)) + '</div>'
    + '<div class="meta">' + esc(ago(pr.updatedAgoMin)) + '</div>'
    + (badges ? '<div class="badges">' + badges + '</div>' : '');
}

function personFoot(p) {
  if (p.paused || !p.presence) return '';
  if (p.precise === 'available') {
    return '<button type="button" class="ghost sm" data-act="precise" data-id="' + esc(p.user.id) + '">' + tx('people.showPrecise') + '</button>';
  }
  if (p.preciseWithheld) return '<p class="hint">' + tx('people.withheld.' + p.preciseWithheld) + '</p>';
  return '';
}

async function loadPeople(box) {
  var r = await api('/v1/people');
  var list = r.people || [];
  if (!list.length) { box.innerHTML = emptyState('people.empty'); return; }
  box.innerHTML = list.map(function (p) {
    return '<article class="person"><div class="avatar" aria-hidden="true">' + esc(initial(p.user.displayName)) + '</div>'
      + '<div class="pmain"><div class="pname">' + esc(p.user.displayName)
      + ' <span class="level">' + tx('level.' + p.level) + '</span></div>' + personBody(p)
      + '<div class="pfoot">' + personFoot(p) + '</div>'
      + '<div class="precise-out" data-precise-for="' + esc(p.user.id) + '"></div></div></article>';
  }).join('');
}

function preciseBlock(p) {
  var c = p.precise;
  if (!c || typeof c !== 'object') {
    return '<p class="hint">' + tx(p.preciseWithheld ? 'people.withheld.' + p.preciseWithheld : 'people.preciseGone') + '</p>';
  }
  var url = safeHttpUrl(c.mapUrl);
  return '<div class="coords"><code>' + esc(Number(c.lat).toFixed(5) + ', ' + Number(c.lon).toFixed(5)) + '</code>'
    + (c.accuracyM != null ? ' <span class="micro">±' + esc(Math.round(c.accuracyM)) + ' m</span>' : '')
    + ' <span class="micro">' + esc(ago(c.updatedAgoMin)) + '</span>'
    + (url ? ' <a class="ghost sm" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + tx('people.openMap') + '</a>' : '')
    + '</div><p class="hint">' + tx('people.audited', { name: p.user.displayName }) + '</p>';
}
`;
