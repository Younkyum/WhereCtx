/**
 * /dashboard/account.js: display name, passkeys, sessions, recovery codes and
 * sign-out. Passkey and recovery changes need a recent passkey proof; api()
 * runs that step-up and retries once.
 */

export const ACCOUNT_JS = String.raw`import { api, bind, confirmed, emptyState, fmtDate, fmtTime, load, pageHead, panel, refreshMe, state, t, toast, tx } from './core.js';
import { addPasskey, renderCodes } from './gate.js';
import { deviceLabel, esc } from './lib.js';

var signOut = function () {};
/** app.js hands over its sign-out routine. */
export function onSignOut(fn) { signOut = fn; }

export function render(root) {
  root.innerHTML = pageHead('account.title') + '<div id="accountBox"><div class="empty">' + tx('common.loading') + '</div></div>';
  var box = root.querySelector('#accountBox');
  var reload = function () { return load(box, function () { return draw(box); }); };
  bind(root, {
    rename: async function (f) {
      await api('/v1/me', { method: 'PATCH', body: { displayName: f.displayName.value.trim() } });
      toast(t('toast.saved')); await reload();
    },
    addPasskey: async function () {
      await addPasskey();
      toast(t('account.passkeyAdded')); await reload();
    },
    delPasskey: async function (el) {
      if (!confirmed('account.passkeyDeleteConfirm', { name: el.getAttribute('data-name') })) return;
      await api('/v1/me/passkeys/' + encodeURIComponent(el.getAttribute('data-id')), { method: 'DELETE' });
      toast(t('toast.deleted')); await reload();
    },
    endSession: async function (el) {
      var current = el.getAttribute('data-current') === '1';
      if (!confirmed(current ? 'account.signOutConfirm' : 'common.confirm')) return;
      await api('/v1/me/sessions/' + encodeURIComponent(el.getAttribute('data-id')), { method: 'DELETE' });
      if (current) { signOut(false); return; }
      toast(t('toast.revoked')); await reload();
    },
    endOthers: async function () {
      if (!confirmed('account.endOthersConfirm')) return;
      var r = await api('/v1/me/sessions/revoke-others', { method: 'POST' });
      toast(t('account.endedOthers', { n: r.revoked })); await reload();
    },
    newCodes: async function () {
      if (!confirmed('account.codesConfirm')) return;
      var r = await api('/v1/me/recovery-codes', { method: 'POST' });
      var out = box.querySelector('#codesOut');
      renderCodes(out, r.recoveryCodes, function () { out.innerHTML = ''; toast(t('toast.saved')); });
    },
    signOut: function () { signOut(true); }
  });
  reload();
}

async function draw(box) {
  var me = await refreshMe();
  var single = me.passkeys.length <= 1;
  var passkeys = me.passkeys.length
    ? '<ul class="items">' + me.passkeys.map(function (p) {
      return '<li><div><b>' + esc(p.name) + '</b><small>' + tx('account.passkeyMeta', { created: fmtDate(p.createdAt), used: p.lastUsedAt ? fmtTime(p.lastUsedAt) : t('tokens.never') }) + '</small></div>'
        + (single ? '' : '<button type="button" class="danger" data-act="delPasskey" data-id="' + esc(p.id) + '" data-name="' + esc(p.name) + '">' + tx('common.delete') + '</button>') + '</li>';
    }).join('') + '</ul>' + (single ? '<p class="hint">' + tx('account.lastPasskeyHint') + '</p>' : '')
    : emptyState('account.noPasskeys');
  var sessions = '<ul class="items">' + me.sessions.map(function (s) {
    var label = deviceLabel(s.userAgent) || t('account.unknownDevice');
    return '<li><div><b>' + esc(label) + '</b>' + (s.current ? ' <span class="chip ok"><span class="dot"></span>' + tx('account.thisDevice') + '</span>' : '')
      + '<small>' + tx('account.sessionMeta', { created: fmtDate(s.createdAt), seen: fmtTime(s.lastSeenAt) }) + '</small></div>'
      + '<button type="button" class="danger" data-act="endSession" data-id="' + esc(s.id) + '" data-current="' + (s.current ? '1' : '0') + '">' + tx(s.current ? 'account.signOut' : 'common.revoke') + '</button></li>';
  }).join('') + '</ul>'
    + (me.sessions.length > 1 ? '<div class="actions-row"><button type="button" class="ghost" data-act="endOthers">' + tx('account.endOthers') + '</button></div>' : '');

  box.innerHTML = '<div class="panels">'
    + panel('account.profile', '<form data-form="rename" class="actions-row"><input name="displayName" required maxlength="64" value="' + esc(me.user.displayName) + '" aria-label="' + tx('account.displayName') + '" />'
      + '<button type="submit" class="btn">' + tx('common.save') + '</button></form>'
      + '<p class="hint">' + tx('account.workspaces', { list: me.workspaces.map(function (w) { return t('account.workspaceItem', { name: w.name, role: t('role.' + w.role) }); }).join(', ') }) + '</p>'
      + '<div class="actions-row"><button type="button" class="ghost" data-act="signOut">' + tx('account.signOut') + '</button></div>')
    + panel('account.passkeys', passkeys + '<div class="actions-row"><button type="button" class="ghost" data-act="addPasskey">' + tx('account.addPasskey') + '</button></div>')
    + panel('account.sessions', sessions)
    + panel('account.recovery', '<p class="hint">' + tx('account.recoveryDesc') + '</p><div class="actions-row"><button type="button" class="ghost" data-act="newCodes">' + tx('account.newCodes') + '</button></div><div id="codesOut"></div>')
    + '</div>';
  state.me = me;
}
`;
