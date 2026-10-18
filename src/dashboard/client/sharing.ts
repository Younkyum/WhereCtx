/**
 * /dashboard/sharing.js: who sees me (one row per person I share a workspace
 * with: off / status only / exact, hide-at-home), who I see (decline), the
 * pause-everything switch, and my shares' audit log.
 */

export const SHARING_JS = String.raw`import { api, bind, confirmed, emptyState, fmtTime, load, myId, pageHead, panel, t, toast, tx } from './core.js';
import { esc } from './lib.js';

export function render(root) {
  root.innerHTML = pageHead('sharing.title', 'sharing.desc') + '<div id="sharing"><div class="empty">' + tx('common.loading') + '</div></div>';
  var box = root.querySelector('#sharing');
  var reload = function () { return load(box, function () { return draw(box); }); };
  bind(root, {
    level: async function (el) {
      var id = el.getAttribute('data-id');
      try {
        if (el.value === 'off') await api('/v1/shares/' + encodeURIComponent(id), { method: 'DELETE' });
        else await api('/v1/shares/' + encodeURIComponent(id), { method: 'PUT', body: { level: el.value } });
        toast(t('toast.saved'));
      } finally { await reload(); }
    },
    hideHome: async function (el) {
      var id = el.getAttribute('data-id');
      try {
        await api('/v1/shares/' + encodeURIComponent(id), { method: 'PUT', body: { level: el.getAttribute('data-level'), hideHomeExact: el.checked } });
        toast(t('toast.saved'));
      } finally { await reload(); }
    },
    decline: async function (el) {
      if (!confirmed('sharing.declineConfirm', { name: el.getAttribute('data-name') })) return;
      await api('/v1/shares/incoming/' + encodeURIComponent(el.getAttribute('data-id')), { method: 'DELETE' });
      toast(t('toast.saved'));
      await reload();
    },
    pause: async function (el) {
      try {
        await api('/v1/privacy', { method: 'PUT', body: { sharingPaused: el.checked } });
        toast(t(el.checked ? 'sharing.pausedOn' : 'sharing.pausedOff'));
      } finally { await reload(); }
    }
  });
  reload();
}

/** Everyone I share at least one workspace with, by user id, with those workspaces' names. */
async function coMembers() {
  var me = myId();
  var byId = {};
  var spaces = (await api('/v1/workspaces')).workspaces;
  var lists = await Promise.all(spaces.map(function (w) {
    return api('/v1/workspaces/' + encodeURIComponent(w.id) + '/members').then(function (r) { return { ws: w, members: r.members }; });
  }));
  lists.forEach(function (l) {
    l.members.forEach(function (m) {
      if (m.userId === me) return;
      var entry = byId[m.userId] || (byId[m.userId] = { id: m.userId, name: m.displayName, spaces: [] });
      entry.spaces.push(l.ws.name);
    });
  });
  return Object.keys(byId).map(function (k) { return byId[k]; })
    .sort(function (a, b) { return a.name.localeCompare(b.name); });
}

async function draw(box) {
  var results = await Promise.all([api('/v1/shares'), coMembers(), api('/v1/privacy'), api('/v1/shares/audit?limit=50')]);
  var shares = results[0];
  var people = results[1];
  var paused = !!(results[2].settings && results[2].settings.sharingPaused);
  var audit = results[3].audit || [];
  var outgoing = {};
  shares.outgoing.forEach(function (s) { outgoing[s.viewer.id] = s; });

  box.innerHTML = '<div class="panels">'
    + panel('sharing.pause.title', pauseBlock(paused), 'full')
    + panel('sharing.outgoing', people.length ? people.map(function (p) { return outgoingRow(p, outgoing[p.id]); }).join('') : emptyState('sharing.noMembers'), 'full')
    + panel('sharing.incoming', shares.incoming.length ? shares.incoming.map(incomingRow).join('') : emptyState('sharing.noIncoming'))
    + panel('sharing.audit', auditTable(audit))
    + '</div>';
}

function pauseBlock(paused) {
  return '<label class="switch"><input type="checkbox" data-change="pause"' + (paused ? ' checked' : '') + ' />'
    + '<span class="track" aria-hidden="true"></span><span><b>' + tx('sharing.pause.label') + '</b><small>' + tx('sharing.pause.desc') + '</small></span></label>';
}

function outgoingRow(p, share) {
  var level = share ? share.level : 'off';
  var opts = ['off', 'coarse', 'precise'].map(function (l) {
    return '<option value="' + l + '"' + (l === level ? ' selected' : '') + '>' + tx('sharing.level.' + l) + '</option>';
  }).join('');
  var hide = share && share.level === 'precise'
    ? '<label class="check"><input type="checkbox" data-change="hideHome" data-id="' + esc(p.id) + '" data-level="precise"' + (share.hideHomeExact ? ' checked' : '') + ' /> <span>' + tx('sharing.hideHome') + '</span></label>'
    : '';
  return '<div class="row-card"><div class="who"><b>' + esc(p.name) + '</b><small>' + esc(p.spaces.join(', ')) + '</small></div>'
    + '<div class="ctl"><select data-change="level" data-id="' + esc(p.id) + '" aria-label="' + tx('sharing.levelFor', { name: p.name }) + '">' + opts + '</select>' + hide + '</div></div>';
}

function incomingRow(s) {
  return '<div class="row-card"><div class="who"><b>' + esc(s.owner.displayName) + '</b><small>' + tx('sharing.level.' + s.level) + '</small></div>'
    + '<div class="ctl"><button type="button" class="danger" data-act="decline" data-id="' + esc(s.owner.id) + '" data-name="' + esc(s.owner.displayName) + '">' + tx('sharing.decline') + '</button></div></div>';
}

function termsText(x) {
  if (!x) return '';
  return t(x.level === 'precise' && x.hideHomeExact ? 'sharing.terms.preciseHomeHidden' : 'sharing.level.' + x.level);
}

function auditTable(audit) {
  if (!audit.length) return emptyState('audit.empty');
  var rows = audit.map(function (a) {
    var detail = a.action === 'changed' ? termsText(a.before) + ' → ' + termsText(a.after)
      : a.action === 'granted' ? termsText(a.after) : '';
    if (a.reason) detail += (detail ? ' · ' : '') + t('audit.reason.' + a.reason);
    return '<tr><td data-label="' + tx('audit.when') + '" class="m">' + esc(fmtTime(a.createdAt)) + '</td>'
      + '<td data-label="' + tx('audit.who') + '">' + esc(a.viewer ? a.viewer.displayName : '') + '</td>'
      + '<td data-label="' + tx('audit.what') + '">' + tx('audit.action.' + a.action) + (detail ? '<small>' + esc(detail) + '</small>' : '') + '</td></tr>';
  }).join('');
  return '<table class="rt"><thead><tr><th>' + tx('audit.when') + '</th><th>' + tx('audit.who') + '</th><th>' + tx('audit.what') + '</th></tr></thead><tbody>' + rows + '</tbody></table>';
}
`;
