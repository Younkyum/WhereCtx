/**
 * Minimal admin dashboard (plan section 9.9).
 *
 * A single self-contained HTML page. Served unauthenticated (no data); the
 * operator pastes an admin token (localStorage) and all data calls hit the REST
 * API with that bearer token.
 *
 * Visual language: "Hermes Teal" command-center aesthetic — dark teal canvas
 * (#041c1c) with a warm cream foreground (#ffe6cb), surfaces derived by mixing
 * cream into the canvas (cards 4%, borders 15%, muted text 55%), a warm amber
 * radial glow, an inline-SVG grain overlay, and monospace instrument labels.
 * Mirrors Nous Research's Hermes dashboard tokens (LENS_0).
 *
 * Bilingual EN/KO (auto-detected, toggleable). Every server value is esc()'d
 * before insertion (XSS defense); attribute sinks are double-quoted. The grain
 * is an inline <svg> element (not a data: URL) so it needs no CSP relaxation.
 */

export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>WhereCtx</title>
<style>
  :root {
    --bg:#041c1c; --cream:#ffe6cb; --glow:rgba(255,189,56,.35);
    --ok:#4ade80; --warn:#ffbd38; --err:#fb2c36;
    --fg:var(--cream);
    --card:color-mix(in srgb, var(--cream) 4%, var(--bg));
    --panel2:color-mix(in srgb, var(--cream) 6%, var(--bg));
    --hover:color-mix(in srgb, var(--cream) 10%, var(--bg));
    --line:color-mix(in srgb, var(--cream) 14%, transparent);
    --line-strong:color-mix(in srgb, var(--cream) 22%, transparent);
    --mut:color-mix(in srgb, var(--cream) 55%, transparent);
    --faint:color-mix(in srgb, var(--cream) 34%, transparent);
    --r:.5rem; --r-sm:calc(var(--r) - 3px);
    --mono:ui-monospace,"SF Mono","JetBrains Mono","Cascadia Mono",Menlo,Consolas,monospace;
    --sans:system-ui,-apple-system,"Segoe UI",Roboto,"Apple SD Gothic Neo","Noto Sans KR","Helvetica Neue",Arial,sans-serif;
  }
  * { box-sizing:border-box; }
  html,body { margin:0; }
  body { font:15px/1.55 var(--sans); color:var(--fg); background:var(--bg); min-height:100vh; -webkit-font-smoothing:antialiased; }
  /* warm amber glow backdrop */
  .bg { position:fixed; inset:0; z-index:-2; background:
      radial-gradient(900px 520px at 78% -8%, var(--glow), transparent 60%),
      radial-gradient(700px 700px at 0% 110%, color-mix(in srgb, var(--glow) 40%, transparent), transparent 60%),
      var(--bg); }
  /* inline-svg grain overlay (CSP-safe, no data: URL) */
  .grain { position:fixed; inset:0; z-index:-1; opacity:.05; pointer-events:none; mix-blend-mode:soft-light; width:100%; height:100%; }
  a { color:inherit; }
  .mono { font-family:var(--mono); }
  .micro { font-family:var(--mono); font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--mut); }

  input,select,textarea { width:100%; background:color-mix(in srgb, var(--cream) 3%, var(--bg)); color:var(--fg); border:1px solid var(--line); border-radius:var(--r-sm); padding:9px 11px; font:inherit; font-size:14px; outline:none; }
  input::placeholder { color:var(--faint); }
  input:focus,select:focus { border-color:color-mix(in srgb, var(--warn) 60%, var(--line)); box-shadow:0 0 0 3px color-mix(in srgb, var(--warn) 16%, transparent); }
  button { font:inherit; cursor:pointer; }
  .btn { background:var(--cream); color:var(--bg); border:0; border-radius:var(--r-sm); padding:9px 14px; font-weight:600; font-size:13px; white-space:nowrap; }
  .btn:hover { filter:brightness(.94); }
  .ghost { background:transparent; color:var(--fg); border:1px solid var(--line); border-radius:var(--r-sm); padding:8px 13px; font-size:13px; }
  .ghost:hover { border-color:var(--line-strong); background:var(--hover); }
  .danger { background:transparent; color:var(--err); border:1px solid var(--line); border-radius:6px; padding:4px 9px; font-size:12px; font-family:var(--mono); }
  .danger:hover { border-color:color-mix(in srgb, var(--err) 55%, transparent); background:color-mix(in srgb, var(--err) 8%, transparent); }
  .hidden { display:none !important; }

  /* shell: rail + main */
  .shell { display:grid; grid-template-columns:236px 1fr; min-height:100vh; }
  .rail { position:sticky; top:0; align-self:start; height:100vh; display:flex; flex-direction:column; gap:6px; padding:18px 14px; border-right:1px solid var(--line); background:color-mix(in srgb, var(--cream) 2.5%, var(--bg)); }
  .rail .brand { display:flex; align-items:center; gap:9px; padding:6px 8px 14px; }
  .rail .brand .mark { width:30px; height:30px; border-radius:8px; display:grid; place-items:center; background:color-mix(in srgb, var(--warn) 18%, transparent); border:1px solid color-mix(in srgb, var(--warn) 40%, transparent); font-size:16px; }
  .rail .brand b { font-size:15px; letter-spacing:.02em; }
  .rail .brand small { display:block; }
  .nav { display:flex; flex-direction:column; gap:2px; margin-top:4px; }
  .nav a { display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:var(--r-sm); color:var(--mut); text-decoration:none; font-size:13.5px; border:1px solid transparent; }
  .nav a .ic { width:18px; text-align:center; opacity:.9; }
  .nav a:hover { color:var(--fg); background:var(--hover); }
  .nav a.on { color:var(--fg); background:color-mix(in srgb, var(--cream) 8%, var(--bg)); border-color:var(--line); }
  .rail .foot { margin-top:auto; display:flex; flex-direction:column; gap:10px; }
  .lang { display:flex; border:1px solid var(--line); border-radius:999px; overflow:hidden; align-self:start; }
  .lang button { background:transparent; color:var(--mut); border:0; padding:5px 12px; font-size:12px; font-family:var(--mono); }
  .lang button.on { background:var(--cream); color:var(--bg); font-weight:600; }

  main { padding:26px 28px 70px; max-width:1100px; }
  /* mobile top bar (rail collapses) */
  .topbar { display:none; }

  /* gate */
  .gate { max-width:430px; margin:14vh auto 0; text-align:center; padding:30px 26px; background:var(--card); border:1px solid var(--line); border-radius:var(--r); box-shadow:0 30px 80px -40px var(--glow); }
  .gate .mark { font-size:32px; }
  .gate h1 { font-size:19px; margin:12px 0 6px; }
  .gate p { color:var(--mut); margin:0 0 20px; font-size:14px; }
  .gate .row { display:flex; gap:8px; }

  /* readout (presence hero) */
  .readout { display:flex; gap:18px; align-items:center; flex-wrap:wrap; padding:22px; border:1px solid var(--line); border-radius:var(--r); background:
      linear-gradient(180deg, color-mix(in srgb, var(--cream) 5%, var(--bg)), var(--card)); position:relative; overflow:hidden; }
  .readout::after { content:""; position:absolute; right:-60px; top:-80px; width:260px; height:260px; background:radial-gradient(circle, var(--glow), transparent 65%); pointer-events:none; }
  .rd-icon { font-size:42px; width:72px; height:72px; display:grid; place-items:center; border-radius:14px; background:color-mix(in srgb, var(--cream) 5%, var(--bg)); border:1px solid var(--line); position:relative; }
  .led { position:absolute; top:8px; right:8px; width:9px; height:9px; border-radius:50%; background:var(--mut); box-shadow:0 0 0 0 transparent; }
  .led.ok { background:var(--ok); box-shadow:0 0 10px 1px color-mix(in srgb, var(--ok) 70%, transparent); }
  .led.warn { background:var(--warn); box-shadow:0 0 10px 1px color-mix(in srgb, var(--warn) 70%, transparent); }
  .led.off { background:var(--faint); }
  .rd-main { flex:1; min-width:200px; z-index:1; }
  .rd-main .status { font-size:26px; font-weight:700; letter-spacing:-.01em; line-height:1.1; margin-top:3px; }
  .rd-main .meta { color:var(--mut); margin-top:5px; font-family:var(--mono); font-size:12.5px; }
  .rd-main .badges { display:flex; gap:7px; flex-wrap:wrap; margin-top:12px; }
  .rd-actions { display:flex; gap:8px; flex-wrap:wrap; z-index:1; }

  .chip { display:inline-flex; align-items:center; gap:6px; padding:3px 9px; border-radius:999px; font-size:11px; font-family:var(--mono); letter-spacing:.03em; background:color-mix(in srgb, var(--cream) 6%, var(--bg)); border:1px solid var(--line); color:var(--mut); }
  .chip.ok { color:var(--ok); border-color:color-mix(in srgb, var(--ok) 35%, transparent); }
  .chip.warn { color:var(--warn); border-color:color-mix(in srgb, var(--warn) 38%, transparent); }
  .chip.cream { color:var(--fg); }
  .dot { width:6px; height:6px; border-radius:50%; background:currentColor; }

  .panels { display:grid; gap:16px; grid-template-columns:1fr 1fr; margin-top:18px; }
  .panel { background:var(--card); border:1px solid var(--line); border-radius:var(--r); padding:18px; scroll-margin-top:20px; }
  .panel.full { grid-column:1 / -1; }
  .phead { display:flex; align-items:center; gap:9px; margin:0 0 14px; }
  .phead .pdot { width:6px; height:6px; border-radius:50%; background:var(--warn); box-shadow:0 0 8px color-mix(in srgb, var(--warn) 70%, transparent); }
  .phead .ptitle { font-family:var(--mono); font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--mut); }
  .phead .pcount { margin-left:auto; font-family:var(--mono); font-size:11px; color:var(--faint); }

  label.fld { display:block; font-size:12px; color:var(--mut); margin:10px 0 5px; }
  .checks { display:grid; grid-template-columns:1fr 1fr; gap:8px 14px; margin-top:8px; }
  .checks label { display:flex; align-items:center; gap:8px; font-size:13px; cursor:pointer; }
  .checks input[type=checkbox] { width:auto; accent-color:var(--warn); }
  .actions-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:16px; }
  .actions-row input, .actions-row select { max-width:100%; }

  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:8px 8px; border-bottom:1px solid var(--line); }
  th { color:var(--faint); font-weight:500; font-size:10.5px; text-transform:uppercase; letter-spacing:.08em; font-family:var(--mono); }
  td.m, .num { font-family:var(--mono); color:var(--mut); }
  tr:last-child td { border-bottom:0; }
  .empty { color:var(--faint); padding:14px 4px; font-size:13px; font-family:var(--mono); }

  .secret { font-family:var(--mono); word-break:break-all; background:color-mix(in srgb, var(--warn) 7%, var(--bg)); padding:11px 12px; border-radius:var(--r-sm); border:1px solid color-mix(in srgb, var(--warn) 45%, transparent); margin-top:12px; font-size:12px; }
  .secret .lab { color:var(--warn); font-size:10.5px; text-transform:uppercase; letter-spacing:.1em; display:block; margin-bottom:6px; }

  #toast { position:fixed; bottom:22px; left:50%; transform:translateX(-50%) translateY(8px); background:color-mix(in srgb, var(--cream) 10%, var(--bg)); border:1px solid var(--line-strong); padding:11px 18px; border-radius:10px; opacity:0; transition:.2s; pointer-events:none; font-size:13.5px; box-shadow:0 16px 40px -12px #000; }
  #toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
  #toast.err { border-color:color-mix(in srgb, var(--err) 60%, transparent); }

  @media (max-width:900px){
    .shell { grid-template-columns:1fr; }
    .rail { position:static; height:auto; flex-direction:row; align-items:center; border-right:0; border-bottom:1px solid var(--line); padding:12px 14px; }
    .rail .brand { padding:0; }
    .nav { display:none; }
    .rail .foot { margin:0 0 0 auto; flex-direction:row; align-items:center; }
    main { padding:18px 16px 60px; }
    .panels { grid-template-columns:1fr; }
    .checks { grid-template-columns:1fr; }
  }
</style>
</head>
<body>
<div class="bg"></div>
<svg class="grain" xmlns="http://www.w3.org/2000/svg"><filter id="gn"><feTurbulence type="fractalNoise" baseFrequency="0.82" numOctaves="2" stitchTiles="stitch"/></filter><rect width="100%" height="100%" filter="url(#gn)"/></svg>

<div class="shell">
  <aside class="rail">
    <div class="brand"><span class="mark">📍</span><div><b>WhereCtx</b><small class="micro" data-i18n="app.subtitle">presence console</small></div></div>
    <nav class="nav" id="nav">
      <a href="#presence" class="on"><span class="ic">◉</span><span data-i18n="nav.overview">Overview</span></a>
      <a href="#places"><span class="ic">⌖</span><span data-i18n="places.title">Places</span></a>
      <a href="#privacy"><span class="ic">⊘</span><span data-i18n="privacy.title">Privacy</span></a>
      <a href="#events"><span class="ic">≡</span><span data-i18n="events.title">Events</span></a>
      <a href="#tokens"><span class="ic">⚷</span><span data-i18n="tokens.title">Tokens</span></a>
      <a href="#webhooks"><span class="ic">⇆</span><span data-i18n="webhooks.title">Webhooks</span></a>
    </nav>
    <div class="foot">
      <div class="lang" id="lang"><button data-lang="en">EN</button><button data-lang="ko">한국어</button></div>
      <div class="conn" id="connBar"></div>
    </div>
  </aside>

  <main>
    <!-- gate -->
    <div id="gate" class="gate">
      <div class="mark">📍</div>
      <h1 data-i18n="connect.title">Connect to WhereCtx</h1>
      <p data-i18n="connect.desc">Paste your admin token to manage presence, places, privacy, tokens, and webhooks.</p>
      <div class="row">
        <input id="gateToken" type="password" data-i18n-ph="connect.placeholder" placeholder="admin token" />
        <button class="btn" id="gateConnect" data-i18n="connect.button">Connect</button>
      </div>
    </div>

    <!-- dashboard -->
    <div id="app" class="hidden">
      <section class="readout" id="presence">
        <div class="rd-icon"><span class="led" id="heroLed"></span><span id="heroIcon">…</span></div>
        <div class="rd-main">
          <div class="micro" data-i18n="presence.title">Current presence</div>
          <div class="status" id="heroStatus">—</div>
          <div class="meta" id="heroMeta"></div>
          <div class="badges" id="heroBadges"></div>
        </div>
        <div class="rd-actions">
          <button class="ghost" id="refresh" data-i18n="presence.refresh">Refresh</button>
          <button class="ghost" id="precise" data-i18n="presence.precise">Precise</button>
        </div>
      </section>

      <div class="panels">
        <section class="panel" id="privacy">
          <div class="phead"><span class="pdot"></span><span class="ptitle" data-i18n="privacy.title">Privacy</span></div>
          <form id="privacyForm">
            <label class="fld" data-i18n="privacy.access">Default agent access</label>
            <select name="defaultAgentAccess">
              <option value="hidden">hidden</option><option value="coarse">coarse</option><option value="precise">precise</option>
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

        <section class="panel" id="events">
          <div class="phead"><span class="pdot"></span><span class="ptitle" data-i18n="events.title">Recent events</span></div>
          <table id="events"><thead><tr><th data-i18n="events.type">Type</th><th data-i18n="events.place">Place</th><th data-i18n="events.when">When</th></tr></thead><tbody></tbody></table>
          <div class="empty hidden" data-empty="events" data-i18n="events.empty">No events yet</div>
        </section>

        <section class="panel full" id="places">
          <div class="phead"><span class="pdot"></span><span class="ptitle" data-i18n="places.title">Places</span></div>
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

        <section class="panel" id="tokens">
          <div class="phead"><span class="pdot"></span><span class="ptitle" data-i18n="tokens.title">Tokens</span></div>
          <table id="tokens"><thead><tr><th data-i18n="tokens.name">Name</th><th data-i18n="tokens.role">Role</th><th data-i18n="tokens.lastUsed">Last used</th><th></th></tr></thead><tbody></tbody></table>
          <div class="empty hidden" data-empty="tokens" data-i18n="tokens.empty">No tokens yet</div>
          <form id="tokenForm" class="actions-row">
            <input name="name" data-i18n-ph="tokens.name" placeholder="name" required style="width:150px" />
            <select name="role" style="width:auto"><option value="device">device</option><option value="agent">agent</option><option value="admin">admin</option></select>
            <button class="btn" data-i18n="tokens.create">Create</button>
          </form>
          <div id="newSecret"></div>
        </section>

        <section class="panel full" id="webhooks">
          <div class="phead"><span class="pdot"></span><span class="ptitle" data-i18n="webhooks.title">Webhooks</span></div>
          <table id="webhooks"><thead><tr><th>URL</th><th data-i18n="webhooks.events">Events</th><th data-i18n="webhooks.active">Active</th><th></th></tr></thead><tbody></tbody></table>
          <div class="empty hidden" data-empty="webhooks" data-i18n="webhooks.empty">No webhooks yet</div>
          <form id="webhookForm" class="actions-row">
            <input name="url" placeholder="https://…" required style="width:230px" />
            <input name="secret" data-i18n-ph="webhooks.secret" placeholder="signing secret (optional)" style="width:190px" />
            <button class="btn" data-i18n="webhooks.add">Add</button>
          </form>
          <div class="phead" style="margin-top:18px"><span class="pdot" style="background:var(--err);box-shadow:0 0 8px color-mix(in srgb,var(--err) 70%,transparent)"></span><span class="ptitle" data-i18n="webhooks.deadletters">Dead-letters</span></div>
          <table id="deadLetters"><thead><tr><th data-i18n="events.type">Type</th><th data-i18n="webhooks.error">Error</th><th data-i18n="events.when">When</th></tr></thead><tbody></tbody></table>
          <div class="empty hidden" data-empty="deadLetters" data-i18n="webhooks.dlEmpty">None — all delivered</div>
        </section>
      </div>
    </div>
  </main>
</div>
<div id="toast"></div>
<script>
var I18N = {
  en: {
    'app.subtitle':'presence console',
    'nav.overview':'Overview',
    'connect.title':'Connect to WhereCtx','connect.desc':'Paste your admin token to manage presence, places, privacy, tokens, and webhooks.',
    'connect.placeholder':'admin token','connect.button':'Connect','connect.disconnect':'Disconnect','connect.connected':'connected',
    'presence.title':'Current presence','presence.refresh':'Refresh','presence.precise':'Precise','presence.none':'No presence recorded yet','presence.hidden':'Hidden from agents',
    'presence.updatedAgo':'updated {x} ago','presence.fresh':'fresh','presence.stale':'stale','presence.motion':'motion','presence.access':'access',
    'privacy.title':'Privacy','privacy.access':'Default agent access','privacy.allowPrecise':'Allow precise to agents','privacy.requireReason':'Precise requires reason','privacy.requireApproval':'Precise requires approval','privacy.hideHome':'Protect home coordinates','privacy.storeHistory':'Store raw history','privacy.retention':'Retention (h)','privacy.save':'Save privacy',
    'places.title':'Places','places.name':'Name','places.type':'Type','places.lat':'Lat','places.lon':'Lon','places.radius':'Radius (m)','places.add':'Add / update','places.empty':'No places yet',
    'events.title':'Events','events.type':'Type','events.place':'Place','events.when':'When','events.empty':'No events yet',
    'tokens.title':'Tokens','tokens.name':'Name','tokens.role':'Role','tokens.lastUsed':'Last used','tokens.create':'Create','tokens.never':'never','tokens.newSecret':'New secret (shown once)','tokens.empty':'No tokens yet',
    'webhooks.title':'Webhooks','webhooks.events':'Events','webhooks.active':'Active','webhooks.add':'Add','webhooks.secret':'signing secret (optional)','webhooks.deadletters':'Dead-letters','webhooks.error':'Error','webhooks.empty':'No webhooks yet','webhooks.dlEmpty':'None — all delivered',
    'common.delete':'Delete','common.revoke':'Revoke','common.yes':'yes','common.no':'no','common.confirm':'Are you sure?',
    'toast.connected':'Connected','toast.forgotten':'Disconnected','toast.saved':'Saved','toast.deleted':'Deleted','toast.revoked':'Revoked','toast.added':'Added',
    'error.generic':'Request failed','error.session':'Session expired — please reconnect','err.reasonRequired':'A reason is required for precise location','err.homeProtected':'Home coordinates are protected','err.preciseDisabled':'Precise location is disabled by policy','err.approvalRequired':'Precise location requires approval','err.reasonLong':'Reason is too long',
    'st.home':'Home','st.near_home':'Near home','st.away':'Away','st.work':'Work','st.near_work':'Near work','st.transit':'In transit','st.custom':'At a place','st.unknown':'Unknown','st.hidden':'Hidden'
  },
  ko: {
    'app.subtitle':'프레즌스 콘솔',
    'nav.overview':'개요',
    'connect.title':'WhereCtx에 연결','connect.desc':'관리자 토큰을 붙여넣어 위치·장소·프라이버시·토큰·웹훅을 관리하세요.',
    'connect.placeholder':'관리자 토큰','connect.button':'연결','connect.disconnect':'연결 해제','connect.connected':'연결됨',
    'presence.title':'현재 위치 상태','presence.refresh':'새로고침','presence.precise':'정밀 위치','presence.none':'아직 기록된 위치가 없습니다','presence.hidden':'에이전트에 비공개',
    'presence.updatedAgo':'{x} 전 갱신','presence.fresh':'최신','presence.stale':'오래됨','presence.motion':'이동','presence.access':'접근',
    'privacy.title':'프라이버시','privacy.access':'기본 에이전트 접근','privacy.allowPrecise':'에이전트에 정밀 위치 허용','privacy.requireReason':'정밀 위치에 사유 필요','privacy.requireApproval':'정밀 위치에 승인 필요','privacy.hideHome':'집 좌표 보호','privacy.storeHistory':'원시 위치 기록 저장','privacy.retention':'보관 (시간)','privacy.save':'저장',
    'places.title':'장소','places.name':'이름','places.type':'유형','places.lat':'위도','places.lon':'경도','places.radius':'반경 (m)','places.add':'추가 / 수정','places.empty':'등록된 장소가 없습니다',
    'events.title':'이벤트','events.type':'유형','events.place':'장소','events.when':'시각','events.empty':'이벤트가 없습니다',
    'tokens.title':'토큰','tokens.name':'이름','tokens.role':'역할','tokens.lastUsed':'마지막 사용','tokens.create':'생성','tokens.never':'사용 안 함','tokens.newSecret':'새 시크릿 (한 번만 표시됩니다)','tokens.empty':'토큰이 없습니다',
    'webhooks.title':'웹훅','webhooks.events':'이벤트','webhooks.active':'활성','webhooks.add':'추가','webhooks.secret':'서명 시크릿 (선택)','webhooks.deadletters':'전송 실패 기록','webhooks.error':'오류','webhooks.empty':'등록된 웹훅이 없습니다','webhooks.dlEmpty':'없음 — 모두 전송됨',
    'common.delete':'삭제','common.revoke':'폐기','common.yes':'예','common.no':'아니오','common.confirm':'정말 진행할까요?',
    'toast.connected':'연결됨','toast.forgotten':'연결 해제됨','toast.saved':'저장됨','toast.deleted':'삭제됨','toast.revoked':'폐기됨','toast.added':'추가됨',
    'error.generic':'요청 실패','error.session':'세션이 만료되었습니다 — 다시 연결하세요','err.reasonRequired':'정밀 위치에는 사유가 필요합니다','err.homeProtected':'집 좌표는 보호되어 있습니다','err.preciseDisabled':'정밀 위치가 정책으로 비활성화되어 있습니다','err.approvalRequired':'정밀 위치에 승인이 필요합니다','err.reasonLong':'사유가 너무 깁니다',
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
    bar.innerHTML = '<span class="chip ok"><span class="dot"></span>'+esc(t('connect.connected'))+'</span> <button class="ghost" id="disc">'+esc(t('connect.disconnect'))+'</button>';
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
    $('#heroLed').className = 'led ' + (p.stale ? 'warn' : 'ok');
    $('#heroMeta').textContent = t('presence.updatedAgo').replace('{x}', ago(p.updatedAgoSec));
    var b = '';
    b += '<span class="chip '+(p.stale?'warn':'ok')+'"><span class="dot"></span>'+esc(p.stale?t('presence.stale'):t('presence.fresh'))+'</span>';
    if(p.motion && p.motion!=='unknown') b += '<span class="chip">'+esc(t('presence.motion'))+': '+esc(p.motion)+'</span>';
    b += '<span class="chip cream">'+esc(t('presence.access'))+': '+esc(p.privacy)+'</span>';
    $('#heroBadges').innerHTML = b;
  } catch(e){
    if(e.status===401){ onUnauthorized(); return; }
    var hidden = e.status===403;
    $('#heroIcon').textContent = hidden ? '🙈' : '❓';
    $('#heroStatus').textContent = hidden ? statusText('hidden') : '—';
    $('#heroLed').className = 'led off';
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
      tr.innerHTML = '<td>'+esc(p.name)+'</td><td>'+esc(p.type)+'</td><td class="m">'+esc(p.lat)+'</td><td class="m">'+esc(p.lon)+'</td><td class="m">'+esc(p.radiusM)+'</td>'
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
      tr.innerHTML='<td class="m">'+esc(e.type)+'</td><td>'+esc(e.placeName||'')+'</td><td class="m">'+esc(fmtTime(e.createdAt))+'</td>';
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
      tr.innerHTML='<td>'+esc(tk.name)+'</td><td class="m">'+esc(tk.role)+'</td><td class="m">'+esc(tk.lastUsedAt?fmtTime(tk.lastUsedAt):t('tokens.never'))+'</td>'
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
      tr.innerHTML='<td class="m">'+esc(w.url)+'</td><td class="m">'+esc((w.events||[]).join(', '))+'</td><td class="m">'+esc(w.active?t('common.yes'):t('common.no'))+'</td>'
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
      tr.innerHTML='<td class="m">'+esc(x.eventType)+'</td><td class="m">'+esc(x.error||'')+'</td><td class="m">'+esc(fmtTime(x.createdAt))+'</td>';
      tb2.appendChild(tr);
    });
    showEmpty('deadLetters', !(d.deadLetters||[]).length);
  } catch(e){ fail(e); }
}
function fmtTime(iso){ try { var d=new Date(iso); return d.toLocaleString(LANG==='ko'?'ko-KR':'en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }); } catch(e){ return iso; } }
function loadAll(){ loadPresence(); loadPrivacy(); loadPlaces(); loadEvents(); loadTokens(); loadWebhooks(); }

function connect(token){ TOKEN = (token||'').trim(); if(!TOKEN) return; unauthorizedHandled=false; localStorage.setItem('wherectx_admin_token', TOKEN); setConnected(true); toast(t('toast.connected')); loadAll(); }
function disconnect(){ TOKEN=''; localStorage.removeItem('wherectx_admin_token'); $('#gateToken').value=''; setConnected(false); toast(t('toast.forgotten')); }

// nav active state (scrollspy)
(function(){
  var links = $$('#nav a');
  var byId = {}; links.forEach(function(a){ byId[a.getAttribute('href').slice(1)] = a; });
  if(window.IntersectionObserver){
    var io = new IntersectionObserver(function(es){
      es.forEach(function(en){ if(en.isIntersecting){ links.forEach(function(a){ a.className=''; }); var a=byId[en.target.id]; if(a) a.className='on'; } });
    }, { rootMargin:'-30% 0px -60% 0px' });
    ['presence','places','privacy','events','tokens','webhooks'].forEach(function(id){ var el=document.getElementById(id); if(el) io.observe(el); });
  }
})();

$$('#lang button').forEach(function(b){ b.onclick = function(){ LANG=b.getAttribute('data-lang'); localStorage.setItem('wherectx_lang', LANG); applyI18n(); setConnected(!!TOKEN); if(TOKEN) loadAll(); }; });
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

applyI18n();
$('#gateToken').value = TOKEN;
setConnected(!!TOKEN);
if(TOKEN){ loadAll(); }
setInterval(function(){ if(TOKEN) loadPresence(); }, 20000);
</script>
</body>
</html>`;
