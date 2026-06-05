/**
 * Minimal admin dashboard (plan section 9.9).
 *
 * A single self-contained HTML page. It is served unauthenticated (it contains
 * no data), and performs all data calls against the REST API with an admin
 * token the operator pastes in (kept in localStorage). This avoids server-side
 * sessions/cookies for v0.1 while keeping every data path behind the same token
 * auth as the rest of the API.
 */

export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>WhereCtx Dashboard</title>
<style>
  :root { --bg:#0f1115; --card:#171a21; --line:#262b36; --fg:#e6e9ef; --mut:#8b93a3; --acc:#5b9dff; --ok:#3fb27f; --warn:#e0a34e; --err:#e0575b; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--fg); }
  header { padding:16px 20px; border-bottom:1px solid var(--line); display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  header h1 { font-size:16px; margin:0; font-weight:600; }
  header .tag { color:var(--mut); font-size:12px; }
  main { max-width:980px; margin:0 auto; padding:20px; display:grid; gap:16px; grid-template-columns:1fr 1fr; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; }
  .card.full { grid-column:1 / -1; }
  .card h2 { font-size:13px; text-transform:uppercase; letter-spacing:.05em; color:var(--mut); margin:0 0 12px; }
  label { display:block; font-size:12px; color:var(--mut); margin:8px 0 4px; }
  input, select, textarea { width:100%; background:#0c0e13; color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; }
  button { background:var(--acc); color:#06122b; border:0; border-radius:6px; padding:8px 12px; font:inherit; font-weight:600; cursor:pointer; }
  button.ghost { background:transparent; color:var(--fg); border:1px solid var(--line); }
  button.danger { background:transparent; color:var(--err); border:1px solid var(--line); }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); }
  th { color:var(--mut); font-weight:500; }
  .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; background:#0c0e13; border:1px solid var(--line); }
  .pill.ok { color:var(--ok); } .pill.warn { color:var(--warn); } .pill.err { color:var(--err); }
  .muted { color:var(--mut); }
  .secret { font-family:ui-monospace,monospace; word-break:break-all; background:#0c0e13; padding:8px; border-radius:6px; border:1px solid var(--warn); }
  #toast { position:fixed; bottom:20px; left:50%; transform:translateX(-50%); background:#1d2230; border:1px solid var(--line); padding:10px 16px; border-radius:8px; opacity:0; transition:.2s; pointer-events:none; }
  #toast.show { opacity:1; }
  @media (max-width:760px){ main{ grid-template-columns:1fr; } }
</style>
</head>
<body>
<header>
  <h1>WhereCtx</h1><span class="tag">admin dashboard</span>
  <div class="row" style="margin-left:auto">
    <input id="token" type="password" placeholder="admin token" style="width:260px" />
    <button id="saveToken">Connect</button>
    <button class="ghost" id="forget">Forget</button>
  </div>
</header>
<main>
  <section class="card">
    <h2>Current presence</h2>
    <div id="presence" class="muted">Connect with an admin token to load.</div>
    <div class="row" style="margin-top:12px">
      <button class="ghost" id="refresh">Refresh</button>
      <button class="ghost" id="precise">Show precise</button>
    </div>
  </section>

  <section class="card">
    <h2>Privacy</h2>
    <form id="privacyForm">
      <label>Default agent access</label>
      <select name="defaultAgentAccess"><option>hidden</option><option>coarse</option><option>precise</option></select>
      <div class="grid2">
        <label><input type="checkbox" name="allowPreciseLocation" /> Allow precise to agents</label>
        <label><input type="checkbox" name="preciseRequiresReason" /> Precise requires reason</label>
        <label><input type="checkbox" name="preciseRequiresApproval" /> Precise requires approval</label>
        <label><input type="checkbox" name="hideHomeExactCoordinates" /> Hide home coordinates</label>
        <label><input type="checkbox" name="storeRawHistory" /> Store raw history</label>
        <label>Retention hours <input type="number" name="retentionHours" min="0" max="8760" /></label>
      </div>
      <div style="margin-top:12px"><button>Save privacy</button></div>
    </form>
  </section>

  <section class="card full">
    <h2>Places</h2>
    <table id="places"><thead><tr><th>Name</th><th>Type</th><th>Lat</th><th>Lon</th><th>Radius (m)</th><th></th></tr></thead><tbody></tbody></table>
    <form id="placeForm" class="row" style="margin-top:12px">
      <input name="name" placeholder="name" required style="width:120px" />
      <select name="type"><option>home</option><option>work</option><option>custom</option></select>
      <input name="lat" type="number" step="any" placeholder="lat" required style="width:110px" />
      <input name="lon" type="number" step="any" placeholder="lon" required style="width:110px" />
      <input name="radiusM" type="number" step="any" placeholder="radius m" value="150" required style="width:100px" />
      <button>Add / update</button>
    </form>
  </section>

  <section class="card">
    <h2>Recent events</h2>
    <table id="events"><thead><tr><th>Type</th><th>Place</th><th>When</th></tr></thead><tbody></tbody></table>
  </section>

  <section class="card">
    <h2>Tokens</h2>
    <table id="tokens"><thead><tr><th>Name</th><th>Role</th><th>Last used</th><th></th></tr></thead><tbody></tbody></table>
    <form id="tokenForm" class="row" style="margin-top:12px">
      <input name="name" placeholder="name" required style="width:140px" />
      <select name="role"><option>device</option><option>agent</option><option>admin</option></select>
      <button>Create</button>
    </form>
    <div id="newSecret"></div>
  </section>

  <section class="card full">
    <h2>Webhooks</h2>
    <table id="webhooks"><thead><tr><th>URL</th><th>Events</th><th>Active</th><th></th></tr></thead><tbody></tbody></table>
    <form id="webhookForm" class="row" style="margin-top:12px">
      <input name="url" placeholder="https://…" required style="width:260px" />
      <input name="secret" placeholder="signing secret (optional)" style="width:200px" />
      <button>Add</button>
    </form>
    <h2 style="margin-top:16px">Dead-letters</h2>
    <table id="deadLetters"><thead><tr><th>Event</th><th>Error</th><th>When</th></tr></thead><tbody></tbody></table>
  </section>
</main>
<div id="toast"></div>
<script>
const $ = (s, r=document) => r.querySelector(s);
let TOKEN = localStorage.getItem('wherectx_admin_token') || '';
$('#token').value = TOKEN;

function toast(msg, ok=true){ const t=$('#toast'); t.textContent=msg; t.style.borderColor= ok? 'var(--line)':'var(--err)'; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2200); }
async function api(path, opts={}){
  const headers = Object.assign({'authorization':'Bearer '+TOKEN}, opts.headers||{});
  if(opts.body){ headers['content-type']='application/json'; opts.body=JSON.stringify(opts.body); }
  const res = await fetch(path, Object.assign({}, opts, {headers}));
  const text = await res.text();
  let data; try { data = text? JSON.parse(text): {}; } catch { data = {raw:text}; }
  if(!res.ok){ throw new Error(data.error || data.detail || res.status); }
  return data;
}
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function ago(s){ return s==null? '': s<60? s+'s': Math.round(s/60)+'m'; }

async function loadPresence(){
  try {
    const p = await api('/v1/presence');
    const cls = p.stale? 'warn':'ok';
    $('#presence').innerHTML = '<div class="row"><span class="pill '+cls+'">'+esc(p.status)+'</span>'
      + '<span class="muted">'+esc(p.label)+'</span></div>'
      + '<div class="row" style="margin-top:8px"><span class="pill">motion: '+esc(p.motion)+'</span>'
      + '<span class="pill">updated '+esc(ago(p.updatedAgoSec))+' ago</span>'
      + '<span class="pill '+(p.stale?'warn':'')+'">'+(p.stale?'stale':'fresh')+'</span>'
      + '<span class="pill">agent access: '+esc(p.privacy)+'</span></div>';
  } catch(e){ $('#presence').innerHTML = '<span class="muted">'+esc(e.message)+'</span>'; }
}
async function loadPrivacy(){
  try { const {settings}=await api('/v1/privacy'); const f=$('#privacyForm');
    f.defaultAgentAccess.value=settings.defaultAgentAccess;
    for(const k of ['allowPreciseLocation','preciseRequiresReason','preciseRequiresApproval','hideHomeExactCoordinates','storeRawHistory']) f[k].checked=!!settings[k];
    f.retentionHours.value=settings.retentionHours;
  } catch(e){}
}
async function loadPlaces(){
  try { const {places}=await api('/v1/places'); const tb=$('#places tbody'); tb.innerHTML='';
    for(const p of places){ const tr=document.createElement('tr');
      tr.innerHTML='<td>'+esc(p.name)+'</td><td>'+esc(p.type)+'</td><td>'+esc(p.lat)+'</td><td>'+esc(p.lon)+'</td><td>'+esc(p.radiusM)+'</td>'
        +'<td><button class="danger" data-del="'+esc(p.name)+'">delete</button></td>'; tb.appendChild(tr); }
    tb.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{ await api('/v1/places/'+encodeURIComponent(b.dataset.del),{method:'DELETE'}); toast('deleted'); loadPlaces(); });
  } catch(e){}
}
async function loadEvents(){
  try { const {events}=await api('/v1/events?limit=20'); const tb=$('#events tbody'); tb.innerHTML='';
    for(const e of events){ const tr=document.createElement('tr'); tr.innerHTML='<td>'+esc(e.type)+'</td><td>'+esc(e.placeName||'')+'</td><td class="muted">'+esc(e.createdAt)+'</td>'; tb.appendChild(tr);} } catch(e){}
}
async function loadTokens(){
  try { const {tokens}=await api('/v1/tokens'); const tb=$('#tokens tbody'); tb.innerHTML='';
    for(const t of tokens){ const tr=document.createElement('tr');
      tr.innerHTML='<td>'+esc(t.name)+'</td><td>'+esc(t.role)+'</td><td class="muted">'+esc(t.lastUsedAt||'never')+'</td>'
        +'<td><button class="danger" data-tok="'+esc(t.id)+'">revoke</button></td>'; tb.appendChild(tr); }
    tb.querySelectorAll('[data-tok]').forEach(b=>b.onclick=async()=>{ await api('/v1/tokens/'+b.dataset.tok,{method:'DELETE'}); toast('revoked'); loadTokens(); });
  } catch(e){}
}
async function loadWebhooks(){
  try { const {webhooks}=await api('/v1/webhooks'); const tb=$('#webhooks tbody'); tb.innerHTML='';
    for(const w of webhooks){ const tr=document.createElement('tr');
      tr.innerHTML='<td class="muted">'+esc(w.url)+'</td><td>'+esc((w.events||[]).join(', '))+'</td><td>'+(w.active?'yes':'no')+'</td>'
        +'<td><button class="danger" data-wh="'+esc(w.id)+'">delete</button></td>'; tb.appendChild(tr); }
    tb.querySelectorAll('[data-wh]').forEach(b=>b.onclick=async()=>{ await api('/v1/webhooks/'+b.dataset.wh,{method:'DELETE'}); toast('deleted'); loadWebhooks(); });
  } catch(e){}
  try { const {deadLetters}=await api('/v1/webhooks/dead-letters?limit=20'); const tb=$('#deadLetters tbody'); tb.innerHTML='';
    for(const d of deadLetters){ const tr=document.createElement('tr'); tr.innerHTML='<td>'+esc(d.eventType)+'</td><td class="muted">'+esc(d.error||'')+'</td><td class="muted">'+esc(d.createdAt)+'</td>'; tb.appendChild(tr);} } catch(e){}
}
function loadAll(){ loadPresence(); loadPrivacy(); loadPlaces(); loadEvents(); loadTokens(); loadWebhooks(); }

$('#saveToken').onclick=()=>{ TOKEN=$('#token').value.trim(); localStorage.setItem('wherectx_admin_token',TOKEN); toast('connected'); loadAll(); };
$('#forget').onclick=()=>{ TOKEN=''; localStorage.removeItem('wherectx_admin_token'); $('#token').value=''; toast('forgotten'); };
$('#refresh').onclick=loadPresence;
$('#precise').onclick=async()=>{ try{ const p=await api('/v1/presence/precise?reason=dashboard'); window.open(p.mapUrl,'_blank'); }catch(e){ toast(e.message,false); } };
$('#privacyForm').onsubmit=async ev=>{ ev.preventDefault(); const f=ev.target; const body={ defaultAgentAccess:f.defaultAgentAccess.value, allowPreciseLocation:f.allowPreciseLocation.checked, preciseRequiresReason:f.preciseRequiresReason.checked, preciseRequiresApproval:f.preciseRequiresApproval.checked, hideHomeExactCoordinates:f.hideHomeExactCoordinates.checked, storeRawHistory:f.storeRawHistory.checked, retentionHours:Number(f.retentionHours.value) }; try{ await api('/v1/privacy',{method:'PUT',body}); toast('privacy saved'); loadPresence(); }catch(e){ toast(e.message,false);} };
$('#placeForm').onsubmit=async ev=>{ ev.preventDefault(); const f=ev.target; const body={name:f.name.value,type:f.type.value,lat:Number(f.lat.value),lon:Number(f.lon.value),radiusM:Number(f.radiusM.value)}; try{ await api('/v1/places',{method:'POST',body}); toast('place saved'); f.reset(); loadPlaces(); }catch(e){ toast(e.message,false);} };
$('#tokenForm').onsubmit=async ev=>{ ev.preventDefault(); const f=ev.target; try{ const r=await api('/v1/tokens',{method:'POST',body:{name:f.name.value,role:f.role.value}}); $('#newSecret').innerHTML='<label>New secret (shown once)</label><div class="secret">'+esc(r.secret)+'</div>'; f.reset(); loadTokens(); }catch(e){ toast(e.message,false);} };
$('#webhookForm').onsubmit=async ev=>{ ev.preventDefault(); const f=ev.target; const body={url:f.url.value,events:['*']}; if(f.secret.value) body.secret=f.secret.value; try{ await api('/v1/webhooks',{method:'POST',body}); toast('webhook added'); f.reset(); loadWebhooks(); }catch(e){ toast(e.message,false);} };

if(TOKEN) loadAll();
</script>
</body>
</html>`;
