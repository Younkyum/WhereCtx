/**
 * /dashboard/workspace.js: my workspaces, the selected one's members and
 * invites, rename, leave, and creating a workspace. Controls follow the
 * server's role registry (lib.js), so nobody sees a button they cannot use.
 */

export const WORKSPACE_JS = String.raw`import { api, bind, confirmed, emptyState, fmtDate, fmtTime, load, myId, pageHead, panel, refreshMe, secretBox, t, toast, tx } from './core.js';
import { can, esc, inviteRoles, memberActions } from './lib.js';

var PICK_KEY = 'wherectx_workspace';
var picked = null;

function rememberPick(id) {
  picked = id;
  try { localStorage.setItem(PICK_KEY, id); } catch (e) { /* private mode */ }
}

function storedPick() {
  if (picked) return picked;
  try { return localStorage.getItem(PICK_KEY); } catch (e) { return null; }
}

/** Select a workspace for the next render (after accepting an invite). */
export function selectWorkspace(id) { rememberPick(id); }

function roleOptions(roles, selected) {
  return roles.map(function (r) { return '<option value="' + r + '"' + (r === selected ? ' selected' : '') + '>' + tx('role.' + r) + '</option>'; }).join('');
}

export function render(root) {
  root.innerHTML = pageHead('ws.title', 'ws.desc') + '<div id="wsBox"><div class="empty">' + tx('common.loading') + '</div></div>';
  var box = root.querySelector('#wsBox');
  var reload = function () { return load(box, function () { return draw(box); }); };
  var wsId = function () { return encodeURIComponent(storedPick()); };
  bind(root, {
    pick: function (el) { rememberPick(el.value); return reload(); },
    rename: async function (f) {
      await api('/v1/workspaces/' + wsId(), { method: 'PATCH', body: { name: f.name.value.trim() } });
      toast(t('toast.saved')); await refreshMe(); await reload();
    },
    role: async function (el) {
      try {
        await api('/v1/workspaces/' + wsId() + '/members/' + encodeURIComponent(el.getAttribute('data-id')), { method: 'PATCH', body: { role: el.value } });
        toast(t('toast.saved'));
      } finally { await reload(); }
    },
    remove: async function (el) {
      if (!confirmed('ws.removeConfirm', { name: el.getAttribute('data-name') })) return;
      await api('/v1/workspaces/' + wsId() + '/members/' + encodeURIComponent(el.getAttribute('data-id')), { method: 'DELETE' });
      toast(t('toast.removed')); await reload();
    },
    leave: async function (el) {
      if (!confirmed('ws.leaveConfirm', { name: el.getAttribute('data-name') })) return;
      await api('/v1/workspaces/' + wsId() + '/members/' + encodeURIComponent(myId()), { method: 'DELETE' });
      picked = null;
      try { localStorage.removeItem(PICK_KEY); } catch (e) { /* private mode */ }
      toast(t('ws.left')); await refreshMe(); await reload();
    },
    invite: async function (f) {
      var r = await api('/v1/workspaces/' + wsId() + '/invites', { body: { role: f.role.value } });
      box.querySelector('#inviteOut').innerHTML = '<p>' + tx('ws.inviteCreated', { date: fmtTime(r.expiresAt) }) + '</p>' + secretBox('ws.inviteLink', r.url);
      await drawInvites(box.querySelector('#inviteList'), storedPick(), f.getAttribute('data-role'));
    },
    revokeInvite: async function (el) {
      if (!confirmed('common.confirm')) return;
      await api('/v1/workspaces/' + wsId() + '/invites/' + encodeURIComponent(el.getAttribute('data-id')), { method: 'DELETE' });
      toast(t('toast.revoked'));
      await drawInvites(box.querySelector('#inviteList'), storedPick(), el.getAttribute('data-role'));
    },
    create: async function (f) {
      var r;
      try {
        r = await api('/v1/workspaces', { body: { name: f.name.value.trim() } });
      } catch (e) {
        if (e.code === 'forbidden') throw new Error(t('ws.createForbidden'));
        throw e;
      }
      rememberPick(r.workspace.id);
      toast(t('ws.created')); await refreshMe(); await reload();
    }
  });
  reload();
}

async function draw(box) {
  var spaces = (await api('/v1/workspaces')).workspaces || [];
  var createForm = panel('ws.create', '<form data-form="create" class="actions-row"><input name="name" required maxlength="64" placeholder="' + tx('ws.namePlaceholder') + '" aria-label="' + tx('ws.name') + '" />'
    + '<button type="submit" class="btn">' + tx('ws.createButton') + '</button></form>');
  if (!spaces.length) { box.innerHTML = emptyState('ws.none') + '<div class="panels">' + createForm + '</div>'; return; }
  var ws = spaces.filter(function (w) { return w.id === storedPick(); })[0] || spaces[0];
  rememberPick(ws.id);
  var role = ws.role;

  var switcher = spaces.length > 1
    ? '<label class="fld" for="ws-pick">' + tx('ws.switch') + '</label><select id="ws-pick" data-change="pick">'
      + spaces.map(function (w) { return '<option value="' + esc(w.id) + '"' + (w.id === ws.id ? ' selected' : '') + '>' + esc(w.name) + ' · ' + tx('role.' + w.role) + '</option>'; }).join('') + '</select>'
    : '';
  var summary = '<div class="ws-head"><div><div class="micro">' + tx('ws.current') + '</div><div class="ws-name">' + esc(ws.name) + '</div>'
    + '<div class="meta">' + tx('ws.yourRole', { role: t('role.' + role) }) + '</div></div>'
    + '<button type="button" class="danger" data-act="leave" data-name="' + esc(ws.name) + '">' + tx('ws.leave') + '</button></div>'
    + switcher
    + (can(role, 'rename')
      ? '<form data-form="rename" class="actions-row"><input name="name" required maxlength="64" value="' + esc(ws.name) + '" aria-label="' + tx('ws.name') + '" /><button type="submit" class="ghost">' + tx('ws.rename') + '</button></form>'
      : '');

  var invitable = inviteRoles(role);
  var invites = invitable.length
    ? panel('ws.invites', '<form data-form="invite" data-role="' + esc(role) + '" class="actions-row"><select name="role" aria-label="' + tx('ws.inviteRole') + '">' + roleOptions(invitable, 'member') + '</select>'
      + '<button type="submit" class="btn">' + tx('ws.inviteButton') + '</button></form><div id="inviteOut"></div><div id="inviteList"></div>')
    : '';

  box.innerHTML = '<div class="panels">' + panel('ws.overview', summary, 'full')
    + panel('ws.members', '<div id="memberList"><div class="empty">' + tx('common.loading') + '</div></div>', 'full')
    + invites + createForm + '</div>';

  var members = (await api('/v1/workspaces/' + encodeURIComponent(ws.id) + '/members')).members || [];
  box.querySelector('#memberList').innerHTML = memberTable(members, role);
  if (invitable.length) await drawInvites(box.querySelector('#inviteList'), ws.id, role);
}

function memberTable(members, role) {
  var me = myId();
  return '<table class="rt"><thead><tr><th>' + tx('ws.member') + '</th><th>' + tx('ws.role') + '</th><th>' + tx('ws.joined') + '</th><th></th></tr></thead><tbody>'
    + members.map(function (m) {
      var a = memberActions(role, me, m);
      var roleCell = a.changeRole
        ? '<select data-change="role" data-id="' + esc(m.userId) + '" aria-label="' + tx('ws.roleFor', { name: m.displayName }) + '">' + roleOptions(a.roleChoices, m.role) + '</select>'
        : tx('role.' + m.role);
      return '<tr><td data-label="' + tx('ws.member') + '">' + esc(m.displayName) + (a.self ? ' <span class="chip">' + tx('ws.you') + '</span>' : '') + '</td>'
        + '<td data-label="' + tx('ws.role') + '">' + roleCell + '</td>'
        + '<td data-label="' + tx('ws.joined') + '" class="m">' + esc(fmtDate(m.joinedAt)) + '</td>'
        + '<td class="act">' + (a.remove ? '<button type="button" class="danger" data-act="remove" data-id="' + esc(m.userId) + '" data-name="' + esc(m.displayName) + '">' + tx('ws.remove') + '</button>' : '') + '</td></tr>';
    }).join('') + '</tbody></table>';
}

async function drawInvites(box, wsId, role) {
  var invites = (await api('/v1/workspaces/' + encodeURIComponent(wsId) + '/invites')).invites || [];
  if (!invites.length) { box.innerHTML = emptyState('ws.noInvites'); return; }
  var manageable = inviteRoles(role);
  box.innerHTML = '<table class="rt"><thead><tr><th>' + tx('ws.role') + '</th><th>' + tx('ws.createdAt') + '</th><th>' + tx('ws.expires') + '</th><th></th></tr></thead><tbody>'
    + invites.map(function (i) {
      return '<tr><td data-label="' + tx('ws.role') + '">' + tx('role.' + i.role) + '</td>'
        + '<td data-label="' + tx('ws.createdAt') + '" class="m">' + esc(fmtTime(i.createdAt)) + '</td>'
        + '<td data-label="' + tx('ws.expires') + '" class="m">' + esc(fmtTime(i.expiresAt)) + '</td>'
        + '<td class="act">' + (can(role, 'revokeInvite') && manageable.indexOf(i.role) >= 0
          ? '<button type="button" class="danger" data-act="revokeInvite" data-id="' + esc(i.id) + '" data-role="' + esc(role) + '">' + tx('common.revoke') + '</button>' : '') + '</td></tr>';
    }).join('') + '</tbody></table>';
}
`;
