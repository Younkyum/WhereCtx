/**
 * Minimal admin dashboard (plan section 9.9).
 *
 * A single self-contained HTML page. It is served unauthenticated (it contains
 * no data), and performs all data calls against the REST API with an admin
 * token the operator pastes in (kept in localStorage). This avoids server-side
 * sessions/cookies for v0.1 while keeping every data path behind the same token
 * auth as the rest of the API.
 *
 * UI: bilingual (English / Korean, auto-detected, toggleable) with a presence
 * hero and a card grid. All server-supplied values are escaped via esc() before
 * insertion (XSS defense); attribute sinks are double-quoted.
 */

export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>WhereCtx</title>
<style>
  :root {
    --bg:#0b0d12; --bg2:#0f1218; --card:#161a22; --card2:#1b2029; --line:#262c38;
    --fg:#e8ebf2; --mut:#8a93a6; --faint:#5a6376;
    --acc:#5b9dff; --acc-d:#0b1a33;
    --ok:#43c08a; --warn:#e6ad55; --err:#ec6a6f;
    --r:14px; --r-sm:9px;
  }
  * { box-sizing:border-box; }
  html,body { margin:0; }
  body {
    font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;
    background:radial-gradient(1200px 600px at 70% -10%, #131a2a 0%, var(--bg) 55%); color:var(--fg);
    min-height:100vh; -webkit-font-smoothing:antialiased;
  }
  header {
    position:sticky; top:0; z-index:10; backdrop-filter:blur(8px);
    background:rgba(11,13,18,.72); border-bottom:1px solid var(--line);
    padding:12px 18px; display:flex; gap:12px; align-items:center; flex-wrap:wrap;
  }
  .brand { display:flex; align-items:baseline; gap:8px; }
  .brand b { font-size:16px; font-weight:700; letter-spacing:-.01em; }
  .brand span { color:var(--mut); font-size:12px; }
  .spacer { flex:1; }
  .lang { display:flex; border:1px solid var(--line); border-radius:999px; overflow:hidden; }
  .lang button { background:transparent; color:var(--mut); border:0; padding:5px 11px; font:inherit; font-size:12px; cursor:pointer; }
  .lang button.on { background:var(--acc); color:#06122b; font-weight:600; }
  .conn { display:flex; gap:8px; align-items:center; }
  input,select,textarea {
    width:100%; background:#0a0c11; color:var(--fg); border:1px solid var(--line);
    border-radius:var(--r-sm); padding:9px 11px; font:inherit; outline:none;
  }
  input:focus,select:focus { border-color:var(--acc); box-shadow:0 0 0 3px rgba(91,157,255,.15); }
  button.btn { background:var(--acc); color:#06122b; border:0; border-radius:var(--r-sm); padding:9px 14px; font:inherit; font-weight:600; cursor:pointer; white-space:nowrap; }
  button.btn:hover { filter:brightness(1.06); }
  button.ghost { background:transparent; color:var(--fg); border:1px solid var(--line); border-radius:var(--r-sm); padding:8px 13px; font:inherit; cursor:pointer; }
  button.ghost:hover { border-color:var(--acc); color:#fff; }
  button.danger { background:transparent; color:var(--err); border:1px solid var(--line); border-radius:7px; padding:5px 10px; font:inherit; font-size:12px; cursor:pointer; }
  button.danger:hover { border-color:var(--err); }

  main { max-width:1000px; margin:0 auto; padding:22px 18px 60px; }
  .hidden { display:none !important; }

  /* gate (pre-connect) */
  .gate { max-width:440px; margin:12vh auto 0; text-align:center; padding:28px; background:var(--card); border:1px solid var(--line); border-radius:var(--r); }
  .gate .logo { font-size:34px; }
  .gate h1 { font-size:19px; margin:10px 0 6px; }
  .gate p { color:var(--mut); margin:0 0 18px; }
  .gate .row { display:flex; gap:8px; }

  /* hero */
  .hero { background:linear-gradient(180deg,var(--card2),var(--card)); border:1px solid var(--line); border-radius:var(--r); padding:20px 22px; display:flex; gap:18px; align-items:center; flex-wrap:wrap; }
  .hero .icon { font-size:46px; line-height:1; width:74px; height:74px; display:grid; place-items:center; border-radius:18px; background:#0c0f15; border:1px solid var(--line); }
  .hero .main { flex:1; min-width:180px; }
  .hero .status { font-size:24px; font-weight:700; letter-spacing:-.01em; }
  .hero .meta { color:var(--mut); margin-top:4px; }
  .hero .badges { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
  .hero .actions { display:flex; gap:8px; flex-wrap:wrap; }
  .accent-ok { color:var(--ok); } .accent-warn { color:var(--warn); } .accent-acc { color:var(--acc); } .accent-mut { color:var(--mut); }

  .grid { display:grid; gap:16px; grid-template-columns:1fr 1fr; margin-top:16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:var(--r); padding:18px; }
  .card.full { grid-column:1 / -1; }
  .card h2 { font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--mut); margin:0 0 14px; display:flex; align-items:center; gap:8px; }
  .card h2 .ic { font-size:14px; }
  label.fld { display:block; font-size:12px; color:var(--mut); margin:10px 0 5px; }
  .checks { display:grid; grid-template-columns:1fr 1fr; gap:6px 14px; margin-top:6px; }
  .checks label { display:flex; align-items:center; gap:8px; font-size:13px; color:var(--fg); cursor:pointer; }
  .checks input[type=checkbox] { width:auto; accent-color:var(--acc); }
  .actions-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:14px; }
  .actions-row input, .actions-row select { max-width:100%; }

  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:8px 8px; border-bottom:1px solid var(--line); }
  th { color:var(--faint); font-weight:500; font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
  tr:last-child td { border-bottom:0; }
  .empty { color:var(--faint); padding:14px 4px; font-size:13px; }

  .pill { display:inline-flex; align-items:center; gap:6px; padding:3px 10px; border-radius:999px; font-size:12px; background:#0c0f15; border:1px solid var(--line); color:var(--mut); }
  .pill.ok { color:var(--ok); border-color:rgba(67,192,138,.4); }
  .pill.warn { color:var(--warn); border-color:rgba(230,173,85,.4); }
  .pill.acc { color:var(--acc); border-color:rgba(91,157,255,.4); }
  .dot { width:7px; height:7px; border-radius:50%; background:currentColor; }

  .secret { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; word-break:break-all; background:#0c0f15; padding:10px 12px; border-radius:var(--r-sm); border:1px solid var(--warn); margin-top:10px; font-size:12px; }
  .secret .lab { color:var(--warn); font-size:11px; text-transform:uppercase; letter-spacing:.05em; display:block; margin-bottom:6px; }

  #toast { position:fixed; bottom:22px; left:50%; transform:translateX(-50%) translateY(8px); background:#1c2230; border:1px solid var(--line); padding:11px 18px; border-radius:10px; opacity:0; transition:.22s; pointer-events:none; box-shadow:0 10px 30px rgba(0,0,0,.4); }
  #toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
  #toast.err { border-color:var(--err); }
  .muted { color:var(--mut); }
  @media (max-width:760px){ .grid{ grid-template-columns:1fr; } .checks{ grid-template-columns:1fr; } }
</style>
</head>
<body>
<header>
  <div class="brand"><b>WhereCtx</b><span data-i18n="app.subtitle">admin dashboard</span></div>
  <div class="spacer"></div>
  <div class="lang" id="lang"><button data-lang="en">EN</button><button data-lang="ko">한국어</button></div>
  <div class="conn" id="connBar"></div>
</header>

<main>
  <!-- pre-connect gate -->
  <div id="gate" class="gate">
    <div class="logo">📍</div>
    <h1 data-i18n="connect.title">Connect to WhereCtx</h1>
    <p data-i18n="connect.desc">Paste your admin token to manage presence, places, privacy, tokens, and webhooks.</p>
    <div class="row">
      <input id="gateToken" type="password" data-i18n-ph="connect.placeholder" placeholder="admin token" />
      <button class="btn" id="gateConnect" data-i18n="connect.button">Connect</button>
    </div>
  </div>

  <!-- dashboard (post-connect) -->
  <div id="app" class="hidden">
    <section class="hero">
      <div class="icon" id="heroIcon">…</div>
      <div class="main">
        <div class="status" id="heroStatus">—</div>
        <div class="meta" id="heroMeta"></div>
        <div class="badges" id="heroBadges"></div>
      </div>
      <div class="actions">
        <button class="ghost" id="refresh" data-i18n="presence.refresh">Refresh</button>
        <button class="ghost" id="precise" data-i18n="presence.precise">Precise</button>
      </div>
    </section>

    <div class="grid">
      <section class="card">
        <h2><span class="ic">🔒</span><span data-i18n="privacy.title">Privacy</span></h2>
        <form id="privacyForm">
          <label class="fld" data-i18n="privacy.access">Default agent access</label>
          <select name="defaultAgentAccess">
            <option value="hidden">hidden</option>
            <option value="coarse">coarse</option>
            <option value="precise">precise</option>
          </select>
          <div class="checks">
            <label><input type="checkbox" name="allowPreciseLocation" /> <span data-i18n="privacy.allowPrecise">Allow precise to agents</span></label>
            <label><input type="checkbox" name="preciseRequiresReason" /> <span data-i18n="privacy.requireReason">Precise requires reason</span></label>
            <label><input type="checkbox" name="preciseRequiresApproval" /> <span data-i18n="privacy.requireApproval">Precise requires approval</span></label>
            <label><input type="checkbox" name="hideHomeExactCoordinates" /> <span data-i18n="privacy.hideHome">Protect home coordinates</span></label>
            <label><input type="checkbox" name="storeRawHistory" /> <span data-i18n="privacy.storeHistory">Store raw history</span></label>
            <label><span data-i18n="privacy.retention">Retention (h)</span> <input type="number" name="retentionHours" min="0" max="8760" style="width:80px" /></label>
          </div>
          <div class="actions-row"><button class="btn" data-i18n="privacy.save">Save privacy</button></div>
        </form>
      </section>

      <section class="card">
        <h2><span class="ic">🕑</span><span data-i18n="events.title">Recent events</span></h2>
        <table id="events"><thead><tr><th data-i18n="events.type">Type</th><th data-i18n="events.place">Place</th><th data-i18n="events.when">When</th></tr></thead><tbody></tbody></table>
        <div class="empty hidden" data-empty="events" data-i18n="events.empty">No events yet</div>
      </section>

      <section class="card full">
        <h2><span class="ic">📍</span><span data-i18n="places.title">Places</span></h2>
        <table id="places"><thead><tr><th data-i18n="places.name">Name</th><th data-i18n="places.type">Type</th><th data-i18n="places.lat">Lat</th><th data-i18n="places.lon">Lon</th><th data-i18n="places.radius">Radius (m)</th><th></th></tr></thead><tbody></tbody></table>
        <div class="empty hidden" data-empty="places" data-i18n="places.empty">No places yet</div>
        <form id="placeForm" class="actions-row">
          <input name="name" data-i18n-ph="places.name" placeholder="name" required style="width:130px" />
          <select name="type" style="width:auto"><option value="home">home</option><option value="work">work</option><option value="custom">custom</option></select>
          <input name="lat" type="number" step="any" placeholder="lat" required style="width:120px" />
          <input name="lon" type="number" step="any" placeholder="lon" required style="width:120px" />
          <input name="radiusM" type="number" step="any" placeholder="m" value="150" required style="width:90px" />
          <button class="btn" data-i18n="places.add">Add / update</button>
        </form>
      </section>

      <section class="card">
        <h2><span class="ic">🔑</span><span data-i18n="tokens.title">Tokens</span></h2>
        <table id="tokens"><thead><tr><th data-i18n="tokens.name">Name</th><th data-i18n="tokens.role">Role</th><th data-i18n="tokens.lastUsed">Last used</th><th></th></tr></thead><tbody></tbody></table>
        <div class="empty hidden" data-empty="tokens" data-i18n="tokens.empty">No tokens yet</div>
        <form id="tokenForm" class="actions-row">
          <input name="name" data-i18n-ph="tokens.name" placeholder="name" required style="width:150px" />
          <select name="role" style="width:auto"><option value="device">device</option><option value="agent">agent</option><option value="admin">admin</option></select>
          <button class="btn" data-i18n="tokens.create">Create</button>
        </form>
        <div id="newSecret"></div>
      </section>

      <section class="card">
        <h2><span class="ic">🔔</span><span data-i18n="webhooks.title">Webhooks</span></h2>
        <table id="webhooks"><thead><tr><th>URL</th><th data-i18n="webhooks.events">Events</th><th data-i18n="webhooks.active">Active</th><th></th></tr></thead><tbody></tbody></table>
        <div class="empty hidden" data-empty="webhooks" data-i18n="webhooks.empty">No webhooks yet</div>
        <form id="webhookForm" class="actions-row">
          <input name="url" placeholder="https://…" required style="width:230px" />
          <input name="secret" data-i18n-ph="webhooks.secret" placeholder="signing secret (optional)" style="width:190px" />
          <button class="btn" data-i18n="webhooks.add">Add</button>
        </form>
        <h2 style="margin-top:18px"><span class="ic">⚠️</span><span data-i18n="webhooks.deadletters">Dead-letters</span></h2>
        <table id="deadLetters"><thead><tr><th data-i18n="events.type">Type</th><th data-i18n="webhooks.error">Error</th><th data-i18n="events.when">When</th></tr></thead><tbody></tbody></table>
        <div class="empty hidden" data-empty="deadLetters" data-i18n="webhooks.dlEmpty">None — all delivered</div>
      </section>
    </div>
  </div>
</main>
<div id="toast"></div>
<script>
var I18N = {
  en: {
    'app.subtitle':'admin dashboard',
    'connect.title':'Connect to WhereCtx','connect.desc':'Paste your admin token to manage presence, places, privacy, tokens, and webhooks.',
    'connect.placeholder':'admin token','connect.button':'Connect','connect.disconnect':'Disconnect','connect.connected':'connected',
    'presence.refresh':'Refresh','presence.precise':'Precise','presence.none':'No presence recorded yet','presence.hidden':'Hidden from agents',
    'presence.updatedAgo':'updated {x} ago','presence.fresh':'fresh','presence.stale':'stale','presence.motion':'motion','presence.access':'access',
    'privacy.title':'Privacy','privacy.access':'Default agent access','privacy.allowPrecise':'Allow precise to agents','privacy.requireReason':'Precise requires reason','privacy.requireApproval':'Precise requires approval','privacy.hideHome':'Protect home coordinates','privacy.storeHistory':'Store raw history','privacy.retention':'Retention (h)','privacy.save':'Save privacy',
    'places.title':'Places','places.name':'Name','places.type':'Type','places.lat':'Lat','places.lon':'Lon','places.radius':'Radius (m)','places.add':'Add / update','places.empty':'No places yet',
    'events.title':'Recent events','events.type':'Type','events.place':'Place','events.when':'When','events.empty':'No events yet',
    'tokens.title':'Tokens','tokens.name':'Name','tokens.role':'Role','tokens.lastUsed':'Last used','tokens.create':'Create','tokens.never':'never','tokens.newSecret':'New secret (shown once)',
    'webhooks.title':'Webhooks','webhooks.events':'Events','webhooks.active':'Active','webhooks.add':'Add','webhooks.secret':'signing secret (optional)','webhooks.deadletters':'Dead-letters','webhooks.error':'Error','webhooks.empty':'No webhooks yet','webhooks.dlEmpty':'None — all delivered',
    'common.delete':'Delete','common.revoke':'Revoke','common.yes':'yes','common.no':'no','common.confirm':'Are you sure?',
    'toast.connected':'Connected','toast.forgotten':'Disconnected','toast.saved':'Saved','toast.deleted':'Deleted','toast.revoked':'Revoked','toast.added':'Added',
    'tokens.empty':'No tokens yet','error.generic':'Request failed','error.session':'Session expired — please reconnect','err.reasonRequired':'A reason is required for precise location','err.homeProtected':'Home coordinates are protected','err.preciseDisabled':'Precise location is disabled by policy','err.approvalRequired':'Precise location requires approval','err.reasonLong':'Reason is too long',
    'st.home':'Home','st.near_home':'Near home','st.away':'Away','st.work':'Work','st.near_work':'Near work','st.transit':'In transit','st.custom':'At a place','st.unknown':'Unknown','st.hidden':'Hidden'
  },
  ko: {
    'app.subtitle':'관리자 대시보드',
    'connect.title':'WhereCtx에 연결','connect.desc':'관리자 토큰을 붙여넣어 위치·장소·프라이버시·토큰·웹훅을 관리하세요.',
    'connect.placeholder':'관리자 토큰','connect.button':'연결','connect.disconnect':'연결 해제','connect.connected':'연결됨',
    'presence.refresh':'새로고침','presence.precise':'정밀 위치','presence.none':'아직 기록된 위치가 없습니다','presence.hidden':'에이전트에 비공개',
    'presence.updatedAgo':'{x} 전 갱신','presence.fresh':'최신','presence.stale':'오래됨','presence.motion':'이동','presence.access':'접근',
    'privacy.title':'프라이버시','privacy.access':'기본 에이전트 접근','privacy.allowPrecise':'에이전트에 정밀 위치 허용','privacy.requireReason':'정밀 위치에 사유 필요','privacy.requireApproval':'정밀 위치에 승인 필요','privacy.hideHome':'집 좌표 보호','privacy.storeHistory':'원시 위치 기록 저장','privacy.retention':'보관 (시간)','privacy.save':'저장',
    'places.title':'장소','places.name':'이름','places.type':'유형','places.lat':'위도','places.lon':'경도','places.radius':'반경 (m)','places.add':'추가 / 수정','places.empty':'등록된 장소가 없습니다',
    'events.title':'최근 이벤트','events.type':'유형','events.place':'장소','events.when':'시각','events.empty':'이벤트가 없습니다',
    'tokens.title':'토큰','tokens.name':'이름','tokens.role':'역할','tokens.lastUsed':'마지막 사용','tokens.create':'생성','tokens.never':'사용 안 함','tokens.newSecret':'새 시크릿 (한 번만 표시됩니다)',
    'webhooks.title':'웹훅','webhooks.events':'이벤트','webhooks.active':'활성','webhooks.add':'추가','webhooks.secret':'서명 시크릿 (선택)','webhooks.deadletters':'전송 실패 기록','webhooks.error':'오류','webhooks.empty':'등록된 웹훅이 없습니다','webhooks.dlEmpty':'없음 — 모두 전송됨',
    'common.delete':'삭제','common.revoke':'폐기','common.yes':'예','common.no':'아니오','common.confirm':'정말 진행할까요?',
    'toast.connected':'연결됨','toast.forgotten':'연결 해제됨','toast.saved':'저장됨','toast.deleted':'삭제됨','toast.revoked':'폐기됨','toast.added':'추가됨',
    'tokens.empty':'토큰이 없습니다','error.generic':'요청 실패','error.session':'세션이 만료되었습니다 — 다시 연결하세요','err.reasonRequired':'정밀 위치에는 사유가 필요합니다','err.homeProtected':'집 좌표는 보호되어 있습니다','err.preciseDisabled':'정밀 위치가 정책으로 비활성화되어 있습니다','err.approvalRequired':'정밀 위치에 승인이 필요합니다','err.reasonLong':'사유가 너무 깁니다',
    'st.home':'집','st.near_home':'집 근처','st.away':'외부','st.work':'직장','st.near_work':'직장 근처','st.transit':'이동 중','st.custom':'장소에 있음','st.unknown':'알 수 없음','st.hidden':'비공개'
  }
};
var STATUS_ICON = { home:'🏠', near_home:'🏡', away:'🌆', work:'💼', near_work:'🏢', transit:'🚗', custom:'📍', unknown:'❓', hidden:'🙈' };

var $ = function(s,r){ return (r||document).querySelector(s); };
var $$ = function(s,r){ return Array.prototype.slice.call((r||document).querySelectorAll(s)); };
var TOKEN = localStorage.getItem('wherectx_admin_token') || '';
var LANG = localStorage.getItem('wherectx_lang') || (String((navigator.language||'en')).slice(0,2)==='ko' ? 'ko':'en');

function t(k){ return (I18N[LANG] && I18N[LANG][k]) || I18N.en[k] || k; }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
function statusText(st){ return t('st.'+st) || st; }
function ago(s){ if(s==null) return ''; if(s<60) return s+(LANG==='ko'?'초':'s'); if(s<3600) return Math.round(s/60)+(LANG==='ko'?'분':'m'); return Math.round(s/3600)+(LANG==='ko'?'시간':'h'); }

function applyI18n(){
  document.documentElement.lang = LANG;
  $$('[data-i18n]').forEach(function(el){ el.textContent = t(el.getAttribute('data-i18n')); });
  $$('[data-i18n-ph]').forEach(function(el){ el.placeholder = t(el.getAttribute('data-i18n-ph')); });
  $$('#lang button').forEach(function(b){ b.className = (b.getAttribute('data-lang')===LANG) ? 'on':''; });
}

function toast(msg, ok){ var el=$('#toast'); el.textContent=msg; el.className = ok===false ? 'show err':'show'; setTimeout(function(){ el.className=''; }, 2300); }

async function api(path, opts){
  opts = opts || {};
  var headers = Object.assign({ 'authorization':'Bearer '+TOKEN }, opts.headers||{});
  if(opts.body){ headers['content-type']='application/json'; opts.body=JSON.stringify(opts.body); }
  var res = await fetch(path, Object.assign({}, opts, { headers:headers }));
  var text = await res.text(); var data;
  try { data = text ? JSON.parse(text) : {}; } catch(e){ data = { raw:text }; }
  if(!res.ok){ var d = data.detail; if(Array.isArray(d)) d=d.join('; '); var err=new Error(data.error || d || ('HTTP '+res.status)); err.status=res.status; throw err; }
  return data;
}

// Map known server (English) error messages to localized copy; fall back to raw.
var ERRMAP = [
  ['no presence recorded','presence.none'],['hidden from agents','presence.hidden'],
  ['reason is required','err.reasonRequired'],['exact home','err.homeProtected'],
  ['precise location is disabled','err.preciseDisabled'],['interactive approval','err.approvalRequired'],
  ['reason too long','err.reasonLong']
];
function localizeError(e){ var m=String(e&&e.message||''); for(var i=0;i<ERRMAP.length;i++){ if(m.indexOf(ERRMAP[i][0])>=0) return t(ERRMAP[i][1]); } return m || t('error.generic'); }
var unauthorizedHandled=false;
function onUnauthorized(){ if(unauthorizedHandled) return; unauthorizedHandled=true; disconnect(); toast(t('error.session'), false); }
function fail(e){ if(e && e.status===401){ onUnauthorized(); return; } toast(localizeError(e), false); }

function setConnected(on){
  $('#gate').className = on ? 'gate hidden':'gate';
  $('#app').className = on ? '':'hidden';
  var bar = $('#connBar');
  if(on){
    bar.innerHTML = '<span class="pill ok"><span class="dot"></span>'+esc(t('connect.connected'))+'</span> <button class="ghost" id="disc">'+esc(t('connect.disconnect'))+'</button>';
    $('#disc').onclick = disconnect;
  } else { bar.innerHTML=''; }
}

function showEmpty(key, isEmpty){ var e = $('[data-empty="'+key+'"]'); if(e) e.className = 'empty'+(isEmpty?'':' hidden'); }

async function loadPresence(){
  try {
    var p = await api('/v1/presence');
    var st = p.status;
    $('#heroIcon').textContent = STATUS_ICON[st] || '📍';
    $('#heroStatus').textContent = statusText(st);
    $('#heroStatus').className = 'status ' + (p.stale ? 'accent-warn' : (st==='home'||st==='work'?'accent-ok':'accent-acc'));
    $('#heroMeta').textContent = t('presence.updatedAgo').replace('{x}', ago(p.updatedAgoSec));
    var b = '';
    b += '<span class="pill '+(p.stale?'warn':'ok')+'"><span class="dot"></span>'+esc(p.stale?t('presence.stale'):t('presence.fresh'))+'</span>';
    if(p.motion && p.motion!=='unknown') b += '<span class="pill">'+esc(t('presence.motion'))+': '+esc(p.motion)+'</span>';
    b += '<span class="pill acc">'+esc(t('presence.access'))+': '+esc(p.privacy)+'</span>';
    $('#heroBadges').innerHTML = b;
  } catch(e){
    if(e.status===401){ onUnauthorized(); return; }
    var hidden = e.status===403; // policy hides presence -> API returns 403
    $('#heroIcon').textContent = hidden ? '🙈' : '❓';
    $('#heroStatus').textContent = hidden ? statusText('hidden') : '—';
    $('#heroStatus').className = 'status accent-mut';
    $('#heroMeta').textContent = e.status===404 ? t('presence.none') : (hidden ? t('presence.hidden') : localizeError(e));
    $('#heroBadges').innerHTML = '';
  }
}
async function loadPrivacy(){
  try {
    var r = await api('/v1/privacy'); var s = r.settings; var f = $('#privacyForm');
    f.defaultAgentAccess.value = s.defaultAgentAccess;
    ['allowPreciseLocation','preciseRequiresReason','preciseRequiresApproval','hideHomeExactCoordinates','storeRawHistory'].forEach(function(k){ f[k].checked = !!s[k]; });
    f.retentionHours.value = s.retentionHours;
  } catch(e){ fail(e); }
}
async function loadPlaces(){
  try {
    var r = await api('/v1/places'); var tb = $('#places tbody'); tb.innerHTML='';
    (r.places||[]).forEach(function(p){
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>'+esc(p.name)+'</td><td>'+esc(p.type)+'</td><td class="muted">'+esc(p.lat)+'</td><td class="muted">'+esc(p.lon)+'</td><td class="muted">'+esc(p.radiusM)+'</td>'
        + '<td><button class="danger" data-del="'+esc(p.name)+'">'+esc(t('common.delete'))+'</button></td>';
      tb.appendChild(tr);
    });
    showEmpty('places', !(r.places||[]).length);
    $$('#places [data-del]').forEach(function(b){ b.onclick = async function(){
      if(!confirm(t('common.confirm'))) return;
      try { await api('/v1/places/'+encodeURIComponent(b.getAttribute('data-del')), { method:'DELETE' }); toast(t('toast.deleted')); loadPlaces(); loadPresence(); } catch(e){ fail(e); }
    }; });
  } catch(e){ fail(e); }
}
async function loadEvents(){
  try {
    var r = await api('/v1/events?limit=20'); var tb = $('#events tbody'); tb.innerHTML='';
    (r.events||[]).forEach(function(e){
      var tr=document.createElement('tr');
      tr.innerHTML='<td>'+esc(e.type)+'</td><td>'+esc(e.placeName||'')+'</td><td class="muted">'+esc(fmtTime(e.createdAt))+'</td>';
      tb.appendChild(tr);
    });
    showEmpty('events', !(r.events||[]).length);
  } catch(e){ fail(e); }
}
async function loadTokens(){
  try {
    var r = await api('/v1/tokens'); var tb = $('#tokens tbody'); tb.innerHTML='';
    (r.tokens||[]).forEach(function(tk){
      var tr=document.createElement('tr');
      tr.innerHTML='<td>'+esc(tk.name)+'</td><td>'+esc(tk.role)+'</td><td class="muted">'+esc(tk.lastUsedAt?fmtTime(tk.lastUsedAt):t('tokens.never'))+'</td>'
        + '<td><button class="danger" data-tok="'+esc(tk.id)+'">'+esc(t('common.revoke'))+'</button></td>';
      tb.appendChild(tr);
    });
    showEmpty('tokens', !(r.tokens||[]).length);
    $$('#tokens [data-tok]').forEach(function(b){ b.onclick = async function(){
      if(!confirm(t('common.confirm'))) return;
      try { await api('/v1/tokens/'+b.getAttribute('data-tok'), { method:'DELETE' }); toast(t('toast.revoked')); loadTokens(); } catch(e){ fail(e); }
    }; });
  } catch(e){ fail(e); }
}
async function loadWebhooks(){
  try {
    var r = await api('/v1/webhooks'); var tb = $('#webhooks tbody'); tb.innerHTML='';
    (r.webhooks||[]).forEach(function(w){
      var tr=document.createElement('tr');
      tr.innerHTML='<td class="muted">'+esc(w.url)+'</td><td>'+esc((w.events||[]).join(', '))+'</td><td>'+esc(w.active?t('common.yes'):t('common.no'))+'</td>'
        + '<td><button class="danger" data-wh="'+esc(w.id)+'">'+esc(t('common.delete'))+'</button></td>';
      tb.appendChild(tr);
    });
    showEmpty('webhooks', !(r.webhooks||[]).length);
    $$('#webhooks [data-wh]').forEach(function(b){ b.onclick = async function(){
      if(!confirm(t('common.confirm'))) return;
      try { await api('/v1/webhooks/'+b.getAttribute('data-wh'), { method:'DELETE' }); toast(t('toast.deleted')); loadWebhooks(); } catch(e){ fail(e); }
    }; });
  } catch(e){ fail(e); }
  try {
    var d = await api('/v1/webhooks/dead-letters?limit=20'); var tb2 = $('#deadLetters tbody'); tb2.innerHTML='';
    (d.deadLetters||[]).forEach(function(x){
      var tr=document.createElement('tr');
      tr.innerHTML='<td>'+esc(x.eventType)+'</td><td class="muted">'+esc(x.error||'')+'</td><td class="muted">'+esc(fmtTime(x.createdAt))+'</td>';
      tb2.appendChild(tr);
    });
    showEmpty('deadLetters', !(d.deadLetters||[]).length);
  } catch(e){ fail(e); }
}
function fmtTime(iso){ try { var d=new Date(iso); return d.toLocaleString(LANG==='ko'?'ko-KR':'en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }); } catch(e){ return iso; } }
function loadAll(){ loadPresence(); loadPrivacy(); loadPlaces(); loadEvents(); loadTokens(); loadWebhooks(); }

function connect(token){ TOKEN = (token||'').trim(); if(!TOKEN) return; unauthorizedHandled=false; localStorage.setItem('wherectx_admin_token', TOKEN); setConnected(true); toast(t('toast.connected')); loadAll(); }
function disconnect(){ TOKEN=''; localStorage.removeItem('wherectx_admin_token'); $('#gateToken').value=''; setConnected(false); toast(t('toast.forgotten')); }

// language toggle
$$('#lang button').forEach(function(b){ b.onclick = function(){ LANG=b.getAttribute('data-lang'); localStorage.setItem('wherectx_lang', LANG); applyI18n(); setConnected(!!TOKEN); if(TOKEN) loadAll(); }; });

// gate + actions
$('#gateConnect').onclick = function(){ connect($('#gateToken').value); };
$('#gateToken').addEventListener('keydown', function(e){ if(e.key==='Enter') connect($('#gateToken').value); });
$('#refresh').onclick = loadPresence;
$('#precise').onclick = async function(){ try { var p = await api('/v1/presence/precise?reason=dashboard'); var w = window.open(p.mapUrl,'_blank'); if(!w) toast(p.mapUrl); } catch(e){ fail(e); } };

$('#privacyForm').onsubmit = async function(ev){ ev.preventDefault(); var f=ev.target;
  var body = { defaultAgentAccess:f.defaultAgentAccess.value, allowPreciseLocation:f.allowPreciseLocation.checked, preciseRequiresReason:f.preciseRequiresReason.checked, preciseRequiresApproval:f.preciseRequiresApproval.checked, hideHomeExactCoordinates:f.hideHomeExactCoordinates.checked, storeRawHistory:f.storeRawHistory.checked, retentionHours:Number(f.retentionHours.value) };
  try { await api('/v1/privacy', { method:'PUT', body:body }); toast(t('toast.saved')); loadPresence(); } catch(e){ fail(e); }
};
$('#placeForm').onsubmit = async function(ev){ ev.preventDefault(); var f=ev.target;
  var body = { name:f.name.value, type:f.type.value, lat:Number(f.lat.value), lon:Number(f.lon.value), radiusM:Number(f.radiusM.value) };
  try { await api('/v1/places', { method:'POST', body:body }); toast(t('toast.saved')); f.reset(); f.radiusM.value=150; loadPlaces(); loadPresence(); } catch(e){ fail(e); }
};
$('#tokenForm').onsubmit = async function(ev){ ev.preventDefault(); var f=ev.target;
  try { var r = await api('/v1/tokens', { method:'POST', body:{ name:f.name.value, role:f.role.value } });
    $('#newSecret').innerHTML = '<div class="secret"><span class="lab">'+esc(t('tokens.newSecret'))+'</span>'+esc(r.secret)+'</div>';
    f.reset(); loadTokens();
  } catch(e){ fail(e); }
};
$('#webhookForm').onsubmit = async function(ev){ ev.preventDefault(); var f=ev.target;
  var body = { url:f.url.value, events:['*'] }; if(f.secret.value) body.secret=f.secret.value;
  try { await api('/v1/webhooks', { method:'POST', body:body }); toast(t('toast.added')); f.reset(); loadWebhooks(); } catch(e){ fail(e); }
};

// init
applyI18n();
$('#gateToken').value = TOKEN;
setConnected(!!TOKEN);
if(TOKEN){ loadAll(); }
setInterval(function(){ if(TOKEN) loadPresence(); }, 20000);
</script>
</body>
</html>`;
