/**
 * /dashboard/gate.js: everything before a session exists. One screen per
 * mode (sign in, first-time setup, invite sign-up, recovery code, access
 * code), plus the one-time recovery codes and the "add a passkey" prompt
 * after recovery. The signed-in invite acceptance card lives here too.
 */

export const GATE_JS = String.raw`import {
  api, bind, createPasskey, describe, download, fail, fmtTime, getPasskey, t, toast, tx
} from './core.js';
import { deviceLabel, esc, webauthnProblem } from './lib.js';

var current = { mode: 'signin', data: {} };
var root = null;
var finish = function () {};

/** Show the gate in container; onSignedIn runs once a session exists and any codes are saved. */
export function startGate(container, invite, onSignedIn) {
  root = container;
  finish = onSignedIn;
  show(invite ? 'invite' : 'signin', invite ? { token: invite } : {});
}

export function rerenderGate() { if (root) show(current.mode, current.data); }

function show(mode, data) {
  current = { mode: mode, data: data || {} };
  var card = document.createElement('div');
  card.className = 'gate';
  root.innerHTML = '';
  root.appendChild(card);
  MODES[mode](card, current.data);
}

function passkeyName() { return deviceLabel(navigator.userAgent) || undefined; }

function head(titleKey, descKey) {
  return '<div class="mark" aria-hidden="true">&#9673;</div><h1>' + tx(titleKey) + '</h1>'
    + (descKey ? '<p class="lead">' + tx(descKey) + '</p>' : '');
}

function problemNote() {
  var p = webauthnProblem(window);
  if (!p) return '';
  var key = p === 'insecure' ? 'gate.insecure' : 'gate.unsupported';
  return '<div class="note warn" role="alert"><b>' + tx(key + '.title') + '</b><p>'
    + tx(key, { origin: location.origin }) + '</p></div>';
}

function others(except) {
  var links = [['signin', 'gate.signin.link'], ['setup', 'gate.setup.link'], ['recover', 'gate.recover.link'], ['access', 'gate.access.link']]
    .filter(function (l) { return l[0] !== except; })
    .map(function (l) { return '<button type="button" class="linkbtn" data-act="mode" data-mode="' + l[0] + '">' + tx(l[1]) + '</button>'; });
  return '<div class="alt">' + links.join('') + '</div>';
}

function field(name, labelKey, attrs) {
  return '<label class="fld" for="g-' + name + '">' + tx(labelKey) + '</label><input id="g-' + name + '" name="' + name + '" ' + (attrs || '') + ' />';
}

function gateError(card, e) {
  var box = card.querySelector('.gate-err');
  var msg = e && e.status === 401 && current.mode !== 'addPasskey' ? t('gate.err.' + current.mode) : describe(e);
  box.textContent = msg;
  box.className = 'gate-err';
}

function wire(card, handlers) {
  var wrapped = {};
  Object.keys(handlers).forEach(function (k) {
    wrapped[k] = function (el) {
      var box = card.querySelector('.gate-err');
      if (box) box.className = 'gate-err hidden';
      return Promise.resolve(handlers[k](el)).catch(function (e) { gateError(card, e); });
    };
  });
  wrapped.mode = function (el) { show(el.getAttribute('data-mode'), {}); };
  bind(card, wrapped);
}

var ERR = '<div class="gate-err hidden" role="alert"></div>';

var MODES = {
  signin: function (card) {
    card.innerHTML = head('gate.signin.title', 'gate.signin.desc') + problemNote() + ERR
      + '<button type="button" class="btn wide" data-act="passkey">' + tx('gate.signin.button') + '</button>' + others('signin');
    wire(card, {
      passkey: async function () {
        var start = await api('/v1/auth/login/options', { method: 'POST', public: true });
        var response = await getPasskey(start.options);
        await api('/v1/auth/login/verify', { body: { ceremony: start.ceremony, response: response }, public: true });
        finish();
      }
    });
  },

  setup: function (card) {
    card.innerHTML = head('gate.setup.title', 'gate.setup.desc') + problemNote() + ERR
      + '<form data-form="setup" class="stack">'
      + field('code', 'gate.setup.code', 'required autocomplete="off" spellcheck="false" class="mono"')
      + field('displayName', 'gate.displayName', 'required maxlength="64" autocomplete="name"')
      + '<button type="submit" class="btn wide">' + tx('gate.setup.button') + '</button></form>' + others('setup');
    wire(card, {
      setup: async function (form) {
        var code = form.code.value.trim();
        var start = await api('/v1/auth/setup/options', { body: { code: code }, public: true });
        var response = await createPasskey(start.options);
        var done = await api('/v1/auth/setup/verify', { body: { code: code, ceremony: start.ceremony, response: response, passkeyName: passkeyName() }, public: true });
        await api('/v1/me', { method: 'PATCH', body: { displayName: form.displayName.value.trim() } }).catch(fail);
        show('codes', { codes: done.recoveryCodes });
      }
    });
  },

  invite: function (card, data) {
    card.innerHTML = head('gate.invite.title') + '<div class="invite-preview"><div class="empty">' + tx('common.loading') + '</div></div>' + ERR;
    api('/v1/auth/invite/preview', { body: { token: data.token }, public: true }).then(function (p) {
      card.innerHTML = head('gate.invite.title') + invitePreview(p) + problemNote() + ERR
        + '<form data-form="join" class="stack">' + field('displayName', 'gate.displayName', 'required maxlength="64" autocomplete="name"')
        + '<button type="submit" class="btn wide">' + tx('gate.invite.button') + '</button></form>'
        + '<div class="alt"><button type="button" class="linkbtn" data-act="mode" data-mode="signin">' + tx('gate.invite.haveAccount') + '</button></div>';
      wire(card, {
        join: async function (form) {
          var displayName = form.displayName.value.trim();
          var start = await api('/v1/auth/invite/options', { body: { token: data.token, displayName: displayName }, public: true });
          var response = await createPasskey(start.options);
          var joined = await api('/v1/auth/invite/verify', { body: { token: data.token, ceremony: start.ceremony, response: response, passkeyName: passkeyName() }, public: true });
          show('codes', { codes: joined.recoveryCodes });
        }
      });
    }).catch(function (e) {
      card.innerHTML = head('gate.invite.title') + '<div class="note warn" role="alert">' + esc(inviteProblem(e)) + '</div>' + others('');
      wire(card, {});
    });
  },

  recover: function (card) {
    card.innerHTML = head('gate.recover.title', 'gate.recover.desc') + ERR
      + '<form data-form="recover" class="stack">' + field('code', 'gate.recover.code', 'required autocomplete="off" spellcheck="false" class="mono"')
      + '<button type="submit" class="btn wide">' + tx('gate.recover.button') + '</button></form>' + others('recover');
    wire(card, {
      recover: async function (form) {
        await api('/v1/auth/recover', { body: { code: form.code.value.trim() }, public: true });
        show('addPasskey', {});
      }
    });
  },

  access: function (card) {
    card.innerHTML = head('gate.access.title', 'gate.access.desc') + problemNote() + ERR
      + '<form data-form="access" class="stack">' + field('code', 'gate.access.code', 'required autocomplete="off" spellcheck="false" class="mono"')
      + '<button type="submit" class="btn wide">' + tx('gate.access.button') + '</button></form>' + others('access');
    wire(card, {
      access: async function (form) {
        var code = form.code.value.trim();
        var start = await api('/v1/auth/access-code/options', { body: { code: code }, public: true });
        var response = await createPasskey(start.options);
        var done = await api('/v1/auth/access-code/verify', { body: { code: code, ceremony: start.ceremony, response: response, passkeyName: passkeyName() }, public: true });
        show('codes', { codes: done.recoveryCodes });
      }
    });
  },

  addPasskey: function (card) {
    card.innerHTML = head('gate.addPasskey.title', 'gate.addPasskey.desc') + problemNote() + ERR
      + '<button type="button" class="btn wide" data-act="add">' + tx('gate.addPasskey.button') + '</button>'
      + '<div class="alt"><button type="button" class="linkbtn" data-act="skip">' + tx('gate.addPasskey.skip') + '</button></div>';
    wire(card, {
      add: async function () {
        await addPasskey();
        toast(t('account.passkeyAdded'));
        finish();
      },
      skip: function () { finish(); }
    });
  },

  codes: function (card, data) {
    card.innerHTML = head('codes.title', 'codes.desc');
    var box = document.createElement('div');
    card.appendChild(box);
    renderCodes(box, data.codes || [], function () { finish(); });
  }
};

/** Register another passkey for the signed-in person (step-up handled by api). */
export async function addPasskey() {
  var start = await api('/v1/me/passkeys/options', { method: 'POST' });
  var response = await createPasskey(start.options);
  return api('/v1/me/passkeys/verify', { body: { ceremony: start.ceremony, response: response, name: passkeyName() } });
}

function invitePreview(p) {
  return '<div class="invite-preview"><p>' + tx('gate.invite.desc', { workspace: p.workspaceName, role: t('role.' + p.role) }) + '</p>'
    + '<p class="micro">' + tx('gate.invite.expires', { date: fmtTime(p.expiresAt) }) + '</p></div>';
}

function inviteProblem(e) {
  if (e && e.status === 410) return t('gate.invite.gone');
  if (e && e.status === 401) return t('gate.invite.unknown');
  return describe(e);
}

/**
 * Recovery codes, shown once: copy, download, and a confirmation the person
 * must tick before continuing.
 */
export function renderCodes(container, codes, onDone) {
  var text = codes.join('\n');
  var box = document.createElement('div');
  container.innerHTML = '';
  container.appendChild(box);
  box.innerHTML = '<ol class="codes mono">' + codes.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ol>'
    + '<div class="actions-row"><button type="button" class="ghost" data-act="copy" data-copy="' + esc(text) + '">' + tx('common.copy') + '</button>'
    + '<button type="button" class="ghost" data-act="save">' + tx('codes.download') + '</button></div>'
    + '<label class="check"><input type="checkbox" data-change="ack" /> <span>' + tx('codes.saved') + '</span></label>'
    + '<button type="button" class="btn wide" data-act="continue" disabled>' + tx('codes.continue') + '</button>';
  bind(box, {
    save: function () { download('wherectx-recovery-codes.txt', text + '\n', 'text/plain'); },
    ack: function (el) { box.querySelector('[data-act=continue]').disabled = !el.checked; },
    continue: function () { onDone(); }
  });
}

/** Signed-in person opening an invite link: preview, then join or dismiss. */
export function renderInviteAccept(container, token, onClose) {
  container.innerHTML = '<div class="gate">' + head('gate.invite.title') + '<div class="body"><div class="empty">' + tx('common.loading') + '</div></div></div>';
  var card = container.querySelector('.gate');
  var body = card.querySelector('.body');
  api('/v1/auth/invite/preview', { body: { token: token }, public: true }).then(function (p) {
    body.innerHTML = invitePreview(p)
      + '<button type="button" class="btn wide" data-act="accept">' + tx('gate.invite.accept', { workspace: p.workspaceName }) + '</button>'
      + '<div class="alt"><button type="button" class="linkbtn" data-act="later">' + tx('common.notNow') + '</button></div>';
  }).catch(function (e) {
    body.innerHTML = '<div class="note warn" role="alert">' + esc(inviteProblem(e)) + '</div>'
      + '<div class="alt"><button type="button" class="linkbtn" data-act="later">' + tx('common.close') + '</button></div>';
  });
  bind(card, {
    accept: async function () {
      var r = await api('/v1/workspaces/invites/accept', { body: { token: token } });
      toast(t('gate.invite.joined', { workspace: r.workspace.name }));
      onClose('workspace', r.workspace.id);
    },
    later: function () { onClose('home'); }
  });
}
`;
