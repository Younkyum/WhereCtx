/**
 * /dashboard/data.js: my own data views carried over from the single-user
 * dashboard: places, privacy (agent access + pause sharing), events, webhooks.
 */

export const DATA_JS = String.raw`import { api, bind, confirmed, emptyState, fmtTime, load, pageHead, panel, t, toast, tx } from './core.js';
import { esc } from './lib.js';

var PLACE_TYPES = ['home', 'work', 'custom'];

function typeOptions(selected) {
  return PLACE_TYPES.map(function (k) {
    return '<option value="' + k + '"' + (k === selected ? ' selected' : '') + '>' + tx('ptype.' + k) + '</option>';
  }).join('');
}

function th(keys) { return '<thead><tr>' + keys.map(function (k) { return '<th>' + (k ? tx(k) : '') + '</th>'; }).join('') + '</tr></thead>'; }
function td(labelKey, value, cls) { return '<td data-label="' + tx(labelKey) + '"' + (cls ? ' class="' + cls + '"' : '') + '>' + value + '</td>'; }

export function renderPlaces(root) {
  root.innerHTML = pageHead('places.title', 'places.desc')
    + '<div class="panels">'
    + panel('places.list', '<div id="placeList"><div class="empty">' + tx('common.loading') + '</div></div>', 'full')
    + panel('places.addHere',
      '<form data-form="here" class="actions-row"><input name="name" required maxlength="64" placeholder="' + tx('places.name') + '" aria-label="' + tx('places.name') + '" />'
      + '<select name="type" aria-label="' + tx('places.type') + '">' + typeOptions('custom') + '</select>'
      + '<button type="submit" class="btn">' + tx('places.addHereButton') + '</button></form><p class="hint">' + tx('places.addHereHint') + '</p>')
    + panel('places.byCoords',
      '<form data-form="coords" class="grid-form"><input name="name" required maxlength="64" placeholder="' + tx('places.name') + '" aria-label="' + tx('places.name') + '" />'
      + '<select name="type" aria-label="' + tx('places.type') + '">' + typeOptions('home') + '</select>'
      + '<input name="lat" type="number" step="any" min="-90" max="90" required placeholder="' + tx('places.lat') + '" aria-label="' + tx('places.lat') + '" />'
      + '<input name="lon" type="number" step="any" min="-180" max="180" required placeholder="' + tx('places.lon') + '" aria-label="' + tx('places.lon') + '" />'
      + '<input name="radiusM" type="number" step="any" min="1" value="150" required aria-label="' + tx('places.radius') + '" />'
      + '<button type="submit" class="btn">' + tx('places.save') + '</button></form>')
    + '</div>';
  var list = root.querySelector('#placeList');
  var reload = function () { return load(list, function () { return drawPlaces(list); }); };
  bind(root, {
    here: async function (f) {
      await api('/v1/places', { body: { name: f.name.value.trim(), type: f.type.value, useCurrentLocation: true } });
      toast(t('toast.saved')); f.reset(); await reload();
    },
    coords: async function (f) {
      await api('/v1/places', { body: { name: f.name.value.trim(), type: f.type.value, lat: Number(f.lat.value), lon: Number(f.lon.value), radiusM: Number(f.radiusM.value) } });
      toast(t('toast.saved')); f.reset(); f.radiusM.value = 150; await reload();
    },
    delPlace: async function (el) {
      if (!confirmed('places.deleteConfirm', { name: el.getAttribute('data-name') })) return;
      await api('/v1/places/' + encodeURIComponent(el.getAttribute('data-name')), { method: 'DELETE' });
      toast(t('toast.deleted')); await reload();
    }
  });
  reload();
}

async function drawPlaces(box) {
  var places = (await api('/v1/places')).places || [];
  if (!places.length) { box.innerHTML = emptyState('places.empty'); return; }
  box.innerHTML = '<table class="rt">' + th(['places.name', 'places.type', 'places.lat', 'places.lon', 'places.radius', '']) + '<tbody>'
    + places.map(function (p) {
      return '<tr>' + td('places.name', esc(p.name)) + td('places.type', tx('ptype.' + p.type)) + td('places.lat', esc(p.lat), 'm')
        + td('places.lon', esc(p.lon), 'm') + td('places.radius', esc(p.radiusM), 'm')
        + '<td class="act"><button type="button" class="danger" data-act="delPlace" data-name="' + esc(p.name) + '">' + tx('common.delete') + '</button></td></tr>';
    }).join('') + '</tbody></table>';
}

var PRIVACY_FLAGS = ['allowPreciseLocation', 'preciseRequiresReason', 'preciseRequiresApproval', 'hideHomeExactCoordinates', 'protectHomePlace', 'storeRawHistory'];

export function renderPrivacy(root) {
  root.innerHTML = pageHead('privacy.title', 'privacy.desc') + '<div id="privacyBox"><div class="empty">' + tx('common.loading') + '</div></div>';
  var box = root.querySelector('#privacyBox');
  var reload = function () { return load(box, function () { return drawPrivacy(box); }); };
  bind(root, {
    privacy: async function (f) {
      var body = { defaultAgentAccess: f.defaultAgentAccess.value, retentionHours: Number(f.retentionHours.value), sharingPaused: f.sharingPaused.checked };
      PRIVACY_FLAGS.forEach(function (k) { body[k] = f[k].checked; });
      await api('/v1/privacy', { method: 'PUT', body: body });
      toast(t('toast.saved')); await reload();
    }
  });
  reload();
}

async function drawPrivacy(box) {
  var s = (await api('/v1/privacy')).settings;
  var access = ['hidden', 'coarse', 'precise'].map(function (k) {
    return '<option value="' + k + '"' + (s.defaultAgentAccess === k ? ' selected' : '') + '>' + tx('access.' + k) + '</option>';
  }).join('');
  var checks = PRIVACY_FLAGS.map(function (k) {
    return '<label class="check"><input type="checkbox" name="' + k + '"' + (s[k] ? ' checked' : '') + ' /> <span>' + tx('privacy.' + k) + '</span></label>';
  }).join('');
  box.innerHTML = '<form data-form="privacy">'
    + panel('privacy.agents',
      '<label class="fld" for="p-access">' + tx('privacy.defaultAgentAccess') + '</label><select id="p-access" name="defaultAgentAccess">' + access + '</select>'
      + '<div class="checks">' + checks + '</div>'
      + '<label class="fld" for="p-ret">' + tx('privacy.retentionHours') + '</label><input id="p-ret" class="short" type="number" name="retentionHours" min="0" max="8760" value="' + esc(s.retentionHours) + '" />')
    + panel('privacy.people',
      '<label class="check"><input type="checkbox" name="sharingPaused"' + (s.sharingPaused ? ' checked' : '') + ' /> <span>' + tx('sharing.pause.label') + '</span></label>'
      + '<p class="hint">' + tx('privacy.peopleHint') + '</p>')
    + '<div class="actions-row"><button type="submit" class="btn">' + tx('common.save') + '</button></div></form>';
}

export function renderEvents(root) {
  root.innerHTML = pageHead('events.title', 'events.desc') + panel('events.recent', '<div id="eventList"><div class="empty">' + tx('common.loading') + '</div></div>', 'full');
  var box = root.querySelector('#eventList');
  load(box, async function () {
    var events = (await api('/v1/events?limit=50')).events || [];
    if (!events.length) { box.innerHTML = emptyState('events.empty'); return; }
    box.innerHTML = '<table class="rt">' + th(['events.type', 'events.place', 'events.when']) + '<tbody>'
      + events.map(function (e) {
        return '<tr>' + td('events.type', esc(e.type), 'm') + td('events.place', esc(e.placeName || '')) + td('events.when', esc(fmtTime(e.createdAt)), 'm') + '</tr>';
      }).join('') + '</tbody></table>';
  });
}

export function renderWebhooks(root) {
  root.innerHTML = pageHead('webhooks.title', 'webhooks.desc') + '<div class="panels">'
    + panel('webhooks.list', '<div id="hookList"><div class="empty">' + tx('common.loading') + '</div></div>', 'full')
    + panel('webhooks.add',
      '<form data-form="hook" class="actions-row"><input name="url" type="url" required placeholder="https://…" aria-label="URL" />'
      + '<input name="secret" placeholder="' + tx('webhooks.secret') + '" aria-label="' + tx('webhooks.secret') + '" />'
      + '<button type="submit" class="btn">' + tx('webhooks.addButton') + '</button></form>')
    + panel('webhooks.deadLetters', '<div id="deadList"><div class="empty">' + tx('common.loading') + '</div></div>')
    + '</div>';
  var list = root.querySelector('#hookList');
  var dead = root.querySelector('#deadList');
  var reload = function () {
    load(dead, function () { return drawDead(dead); });
    return load(list, function () { return drawHooks(list); });
  };
  bind(root, {
    hook: async function (f) {
      var body = { url: f.url.value.trim(), events: ['*'] };
      if (f.secret.value) body.secret = f.secret.value;
      await api('/v1/webhooks', { body: body });
      toast(t('toast.added')); f.reset(); await reload();
    },
    delHook: async function (el) {
      if (!confirmed('common.confirm')) return;
      await api('/v1/webhooks/' + encodeURIComponent(el.getAttribute('data-id')), { method: 'DELETE' });
      toast(t('toast.deleted')); await reload();
    }
  });
  reload();
}

async function drawHooks(box) {
  var hooks = (await api('/v1/webhooks')).webhooks || [];
  if (!hooks.length) { box.innerHTML = emptyState('webhooks.empty'); return; }
  box.innerHTML = '<table class="rt">' + th(['webhooks.url', 'webhooks.events', 'webhooks.active', '']) + '<tbody>'
    + hooks.map(function (w) {
      return '<tr>' + td('webhooks.url', esc(w.url), 'm wrap') + td('webhooks.events', esc((w.events || []).join(', ')), 'm')
        + td('webhooks.active', tx(w.active ? 'common.yes' : 'common.no'))
        + '<td class="act"><button type="button" class="danger" data-act="delHook" data-id="' + esc(w.id) + '">' + tx('common.delete') + '</button></td></tr>';
    }).join('') + '</tbody></table>';
}

async function drawDead(box) {
  var rows = (await api('/v1/webhooks/dead-letters?limit=20')).deadLetters || [];
  if (!rows.length) { box.innerHTML = emptyState('webhooks.deadEmpty'); return; }
  box.innerHTML = '<table class="rt">' + th(['events.type', 'webhooks.error', 'events.when']) + '<tbody>'
    + rows.map(function (x) {
      return '<tr>' + td('events.type', esc(x.eventType), 'm') + td('webhooks.error', esc(x.error || ''), 'm wrap') + td('events.when', esc(fmtTime(x.createdAt)), 'm') + '</tr>';
    }).join('') + '</tbody></table>';
}
`;
