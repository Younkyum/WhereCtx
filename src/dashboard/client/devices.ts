/**
 * /dashboard/devices.js: connecting phones (OwnTracks by QR code, the iOS
 * Shortcut by URL + header) and agents (an agent token plus its MCP config).
 * Secrets appear once, right after creation; the lists show tokens without them.
 */

export const DEVICES_JS = String.raw`import { api, bind, confirmed, download, emptyState, fmtTime, load, pageHead, panel, secretBox, t, toast, tx } from './core.js';
import { esc } from './lib.js';

function tokenTable(tokens, emptyKey) {
  if (!tokens.length) return emptyState(emptyKey);
  return '<table class="rt"><thead><tr><th>' + tx('tokens.name') + '</th><th>' + tx('tokens.role') + '</th><th>' + tx('tokens.lastUsed') + '</th><th></th></tr></thead><tbody>'
    + tokens.map(function (k) {
      return '<tr><td data-label="' + tx('tokens.name') + '">' + esc(k.name) + '</td>'
        + '<td data-label="' + tx('tokens.role') + '" class="m">' + tx('tokenRole.' + k.role) + '</td>'
        + '<td data-label="' + tx('tokens.lastUsed') + '" class="m">' + esc(k.lastUsedAt ? fmtTime(k.lastUsedAt) : t('tokens.never')) + '</td>'
        + '<td class="act"><button type="button" class="danger" data-act="revoke" data-id="' + esc(k.id) + '" data-name="' + esc(k.name) + '">' + tx('common.revoke') + '</button></td></tr>';
    }).join('') + '</tbody></table>';
}

function tokenList(box, keep, emptyKey) {
  return load(box, async function () {
    var tokens = ((await api('/v1/tokens')).tokens || []).filter(keep);
    box.innerHTML = tokenTable(tokens, emptyKey);
  });
}

async function revoke(el, reload) {
  if (!confirmed('tokens.revokeConfirm', { name: el.getAttribute('data-name') })) return;
  await api('/v1/tokens/' + encodeURIComponent(el.getAttribute('data-id')), { method: 'DELETE' });
  toast(t('toast.revoked'));
  await reload();
}

function isDevice(k) { return k.role === 'device'; }
function isAgent(k) { return k.role !== 'device'; }

export function renderDevices(root) {
  root.innerHTML = pageHead('devices.title', 'devices.desc') + '<div class="panels">'
    + panel('devices.connect',
      '<form data-form="pair" class="stack"><label class="fld" for="d-name">' + tx('devices.name') + '</label>'
      + '<input id="d-name" name="name" required maxlength="64" placeholder="' + tx('devices.namePlaceholder') + '" />'
      + '<fieldset class="choices"><legend class="fld">' + tx('devices.kind') + '</legend>'
      + '<label class="choice"><input type="radio" name="kind" value="owntracks" checked /> <span><b>OwnTracks</b><small>' + tx('devices.owntracksDesc') + '</small></span></label>'
      + '<label class="choice"><input type="radio" name="kind" value="shortcut" /> <span><b>' + tx('devices.shortcut') + '</b><small>' + tx('devices.shortcutDesc') + '</small></span></label>'
      + '</fieldset><button type="submit" class="btn">' + tx('devices.create') + '</button></form><div id="pairOut"></div>', 'full')
    + panel('devices.list', '<div id="deviceList"><div class="empty">' + tx('common.loading') + '</div></div>', 'full')
    + '</div>';
  var out = root.querySelector('#pairOut');
  var list = root.querySelector('#deviceList');
  var reload = function () { return tokenList(list, isDevice, 'devices.empty'); };
  var config = null;
  bind(root, {
    pair: async function (f) {
      out.innerHTML = '';
      try {
        var r = await api('/v1/devices/pair', { body: { name: f.name.value.trim(), kind: f.kind.value } });
        config = r.kind === 'owntracks' ? { name: f.name.value.trim(), json: JSON.stringify(r.config, null, 2) } : null;
        out.innerHTML = r.kind === 'owntracks' ? ownTracksResult(r) : shortcutResult(r);
        f.reset();
        await reload();
      } catch (e) {
        if (e.code !== 'base_url_unusable') throw e;
        out.innerHTML = '<div class="note warn" role="alert"><b>' + tx('devices.baseUrl.title') + '</b><p>' + tx('devices.baseUrl.desc') + '</p>'
          + '<p class="mono small">' + esc(e.message) + '</p></div>';
      }
    },
    saveConfig: function () {
      if (config) download((config.name.replace(/[^A-Za-z0-9_-]+/g, '-') || 'wherectx') + '.otrc', config.json + '\n');
    },
    revoke: function (el) { return revoke(el, reload); }
  });
  reload();
}

function ownTracksResult(r) {
  var svg = typeof r.qrSvg === 'string' && /^\s*<svg[\s>]/.test(r.qrSvg) ? r.qrSvg : '';
  return '<div class="pair"><div class="qr" role="img" aria-label="' + tx('devices.qrAlt') + '">' + svg + '</div>'
    + '<div class="pair-steps"><ol class="steps">'
    + '<li>' + tx('devices.ot.step1') + '</li><li>' + tx('devices.ot.step2') + '</li><li>' + tx('devices.ot.step3') + '</li></ol>'
    + '<div class="actions-row"><a class="btn" href="' + esc(r.link) + '">' + tx('devices.ot.open') + '</a>'
    + '<button type="button" class="ghost" data-act="saveConfig">' + tx('devices.ot.download') + '</button></div>'
    + '<p class="hint">' + tx('devices.secretOnce') + '</p></div></div>';
}

function shortcutResult(r) {
  return '<div class="pair-steps"><ol class="steps">'
    + '<li>' + tx('devices.sc.step1') + '</li>'
    + '<li>' + tx('devices.sc.step2') + secretBox('devices.sc.url', r.url) + '</li>'
    + '<li>' + tx('devices.sc.step3') + secretBox('devices.sc.header', r.headers.Authorization) + '</li>'
    + '<li>' + tx('devices.sc.step4') + '</li>'
    + '<li>' + tx('devices.sc.step5') + '</li></ol>'
    + '<p class="hint">' + tx('devices.secretOnce') + '</p></div>';
}

export function renderAgents(root) {
  root.innerHTML = pageHead('agents.title', 'agents.desc') + '<div class="panels">'
    + panel('agents.create',
      '<form data-form="agent" class="actions-row"><input name="name" required maxlength="64" placeholder="' + tx('agents.namePlaceholder') + '" aria-label="' + tx('tokens.name') + '" />'
      + '<button type="submit" class="btn">' + tx('agents.createButton') + '</button></form><div id="agentOut"></div>', 'full')
    + panel('agents.list', '<div id="agentList"><div class="empty">' + tx('common.loading') + '</div></div>', 'full')
    + '</div>';
  var out = root.querySelector('#agentOut');
  var list = root.querySelector('#agentList');
  var reload = function () { return tokenList(list, isAgent, 'agents.empty'); };
  bind(root, {
    agent: async function (f) {
      var r = await api('/v1/tokens', { body: { name: f.name.value.trim(), role: 'agent' } });
      var mcp = JSON.stringify(r.mcpConfig, null, 2);
      out.innerHTML = '<div class="pair-steps"><p>' + tx('agents.created') + '</p>' + secretBox('agents.token', r.secret)
        + '<div class="secret"><span class="lab">' + tx('agents.mcpConfig') + '</span><pre>' + esc(mcp) + '</pre>'
        + '<button type="button" class="ghost sm" data-act="copy" data-copy="' + esc(mcp) + '">' + tx('common.copy') + '</button></div>'
        + '<p class="hint">' + tx('agents.mcpHint') + '</p><p class="hint">' + tx('devices.secretOnce') + '</p></div>';
      f.reset();
      await reload();
    },
    revoke: function (el) { return revoke(el, reload); }
  });
  reload();
}
`;
