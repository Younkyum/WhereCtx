/**
 * /dashboard/style.css: the monochrome theme (black and white, grayscale
 * only, no gradients). Desktop gets a sticky side rail; under 900px the rail
 * becomes a slim header and navigation moves to a bottom tab bar.
 */

export const DASHBOARD_CSS = String.raw`:root {
  --bg:#ffffff; --ink:#0a0a0b;
  --card:#ffffff; --panel2:#fafafa; --hover:#f4f4f5;
  --accent:#0a0a0b; --on-accent:#ffffff;
  --line:#e7e7ea; --line-strong:#d4d4d8;
  --mut:#6b6b72; --faint:#9a9aa2;
  --fg:var(--ink);
  --shadow:0 1px 2px rgba(0,0,0,.04), 0 12px 30px -22px rgba(0,0,0,.22);
  --r:.85rem; --r-sm:calc(var(--r) - 5px);
  --mono:ui-monospace,"SF Mono","JetBrains Mono","Cascadia Mono",Menlo,Consolas,monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,"Apple SD Gothic Neo","Noto Sans KR","Helvetica Neue",Arial,sans-serif;
  --tabbar-h:64px;
}
* { box-sizing:border-box; }
html,body { margin:0; }
body { font:16px/1.6 var(--sans); color:var(--fg); background:var(--bg); min-height:100vh; -webkit-font-smoothing:antialiased; overflow-x:hidden; }
a { color:inherit; }
h1,h2 { margin:0; }
.mono, code, pre { font-family:var(--mono); }
.micro { font-family:var(--mono); font-size:12px; letter-spacing:.12em; text-transform:uppercase; color:var(--mut); }
.hidden { display:none !important; }
html[lang=ko] .micro, html[lang=ko] .ptitle, html[lang=ko] th, html[lang=ko] .chip { letter-spacing:0; }
.small { font-size:13px; }

input,select,textarea { width:100%; max-width:100%; background:#fff; color:var(--fg); border:1px solid var(--line-strong); border-radius:var(--r-sm); padding:11px 13px; font:inherit; font-size:15px; outline:none; min-width:0; }
input::placeholder { color:var(--faint); }
input:focus,select:focus,textarea:focus { border-color:var(--ink); box-shadow:0 0 0 3px rgba(10,10,11,.10); }
input[type=checkbox], input[type=radio] { width:17px; height:17px; padding:0; accent-color:var(--ink); flex:none; }
input.short { max-width:140px; }
button { font:inherit; cursor:pointer; }
button:disabled { opacity:.5; cursor:default; }
:focus-visible { outline:2px solid var(--ink); outline-offset:2px; }
.btn { display:inline-flex; align-items:center; justify-content:center; gap:8px; background:var(--accent); color:var(--on-accent); border:1px solid var(--accent); border-radius:var(--r-sm); padding:11px 20px; font-weight:600; font-size:15px; text-decoration:none; white-space:nowrap; }
.btn:hover:not(:disabled) { background:#26262a; border-color:#26262a; }
.btn.wide { width:100%; margin-top:6px; white-space:normal; overflow-wrap:anywhere; text-align:center; }
.ghost { display:inline-flex; align-items:center; gap:6px; background:var(--card); color:var(--fg); border:1px solid var(--line-strong); border-radius:var(--r-sm); padding:10px 16px; font-size:15px; text-decoration:none; white-space:nowrap; }
.ghost:hover:not(:disabled) { background:var(--hover); border-color:var(--ink); }
.ghost.sm { padding:6px 11px; font-size:13px; }
.danger { background:transparent; color:var(--mut); border:1px solid var(--line-strong); border-radius:7px; padding:6px 11px; font-size:13px; font-family:var(--mono); white-space:nowrap; }
.danger:hover:not(:disabled) { color:var(--ink); border-color:var(--ink); background:var(--hover); }
.linkbtn { background:none; border:0; padding:4px 2px; color:var(--mut); text-decoration:underline; text-underline-offset:3px; font-size:14px; }
.linkbtn:hover { color:var(--ink); }

/* shell */
.shell { display:grid; grid-template-columns:260px minmax(0,1fr); min-height:100vh; }
.rail { position:sticky; top:0; align-self:start; height:100vh; display:flex; flex-direction:column; gap:6px; padding:24px 18px; border-right:1px solid var(--line); background:var(--panel2); }
.brand { display:flex; align-items:center; gap:11px; padding:6px 8px 18px; }
.brand .mark { width:36px; height:36px; border-radius:10px; display:grid; place-items:center; background:var(--ink); color:#fff; font-size:17px; }
.brand b { font-size:17px; letter-spacing:.01em; display:block; line-height:1.2; }
.nav { display:flex; flex-direction:column; gap:3px; margin-top:6px; overflow-y:auto; }
.nav a, .sheet-nav a { display:flex; align-items:center; gap:12px; padding:10px 12px; border-radius:var(--r-sm); color:var(--mut); text-decoration:none; font-size:15px; border:1px solid transparent; }
.nav a .ic, .sheet-nav a .ic { width:20px; text-align:center; opacity:.75; }
.nav a:hover { color:var(--ink); background:var(--hover); }
.nav a.on { color:var(--ink); background:#fff; border-color:var(--line-strong); font-weight:600; box-shadow:var(--shadow); }
.foot { margin-top:auto; display:flex; flex-direction:column; gap:12px; }
.who-name { font-size:14px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:block; }
.lang { display:inline-flex; border:1px solid var(--line-strong); border-radius:999px; overflow:hidden; align-self:start; }
.lang button { background:transparent; color:var(--mut); border:0; padding:6px 13px; font-size:13px; font-family:var(--mono); }
.lang button.on { background:var(--ink); color:var(--on-accent); font-weight:600; }
body[data-mode=gate] .nav, body[data-mode=gate] .tabbar, body[data-mode=gate] #who,
body[data-mode=loading] .nav, body[data-mode=loading] .tabbar { display:none; }

main { padding:36px 44px 80px; max-width:1280px; margin:0 auto; width:100%; min-width:0; }
.vhead { margin:0 0 22px; }
.vhead h1 { font-size:28px; letter-spacing:-.02em; line-height:1.2; }
.vhead p { color:var(--mut); margin:6px 0 0; max-width:70ch; }

/* gate */
.gate { max-width:460px; margin:9vh auto 0; text-align:center; padding:36px 30px; background:var(--card); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--shadow); }
.gate .mark { font-size:34px; line-height:1; }
.gate h1 { font-size:23px; margin:14px 0 8px; }
.gate .lead { color:var(--mut); margin:0 0 20px; font-size:15px; }
.gate form, .gate .stack { text-align:left; }
.gate .alt { display:flex; flex-wrap:wrap; justify-content:center; gap:4px 16px; margin-top:20px; }
.gate-err { margin:0 0 14px; padding:10px 12px; border:1px solid var(--ink); border-left-width:4px; border-radius:var(--r-sm); text-align:left; font-size:14px; }
.invite-preview { margin:0 0 16px; }
.note { text-align:left; padding:12px 14px; border:1px solid var(--line-strong); border-radius:var(--r-sm); background:var(--panel2); margin:0 0 16px; font-size:14px; }
.note.warn { border-color:var(--ink); border-left-width:4px; }
.note p { margin:4px 0 0; color:var(--mut); }
.codes { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px 18px; text-align:left; padding:14px 14px 14px 34px; margin:0 0 14px; background:var(--panel2); border:1px solid var(--line-strong); border-radius:var(--r-sm); font-size:14px; }
.check { display:flex; align-items:center; gap:10px; font-size:14.5px; cursor:pointer; margin:12px 0; text-align:left; }

/* forms */
label.fld, legend.fld { display:block; font-size:13px; color:var(--mut); margin:12px 0 6px; padding:0; }
.stack > input, .stack > select { margin-bottom:4px; }
.actions-row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:14px; }
.actions-row input, .actions-row select { flex:1 1 180px; width:auto; }
.grid-form { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; }
.checks { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:4px 18px; margin-top:8px; }
fieldset.choices { border:0; padding:0; margin:0 0 12px; min-width:0; }
.choice { display:flex; gap:12px; align-items:flex-start; padding:12px 14px; border:1px solid var(--line-strong); border-radius:var(--r-sm); margin-bottom:8px; cursor:pointer; }
.choice:has(input:checked) { border-color:var(--ink); }
.choice input { margin-top:4px; }
.choice small, .who small, .items small, td small { display:block; color:var(--mut); font-size:13px; }
.hint { color:var(--mut); font-size:13.5px; margin:8px 0 0; }

/* panels */
.panels { display:grid; gap:20px; grid-template-columns:repeat(auto-fit,minmax(min(100%,440px),1fr)); }
.panel { background:var(--card); border:1px solid var(--line); border-radius:var(--r); padding:24px; box-shadow:var(--shadow); min-width:0; margin-bottom:0; }
.view > .panel { margin-top:20px; }
.panel.full { grid-column:1 / -1; }
.phead { display:flex; align-items:center; gap:10px; margin:0 0 16px; }
.phead .pdot { width:7px; height:7px; border-radius:50%; background:var(--ink); }
.ptitle { font-family:var(--mono); font-size:12px; font-weight:500; letter-spacing:.14em; text-transform:uppercase; color:var(--mut); }
.empty { color:var(--faint); padding:14px 2px; font-size:14px; font-family:var(--mono); }
.empty.err { color:var(--ink); }

/* my status */
.readout { display:flex; gap:24px; align-items:center; flex-wrap:wrap; padding:28px 30px; border:1px solid var(--line); border-radius:var(--r); background:var(--card); box-shadow:var(--shadow); }
.rd-main { flex:1 1 260px; min-width:0; }
.rd-main .status { font-size:36px; font-weight:700; letter-spacing:-.02em; line-height:1.1; margin-top:6px; }
.meta { color:var(--mut); font-family:var(--mono); font-size:13.5px; margin-top:6px; }
.badges { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
.rd-actions { flex:0 1 280px; }
.rd-actions .btn { width:100%; }
.chip { display:inline-flex; align-items:center; gap:7px; padding:4px 11px; border-radius:999px; font-size:12.5px; font-family:var(--mono); background:var(--panel2); border:1px solid var(--line-strong); color:var(--mut); white-space:nowrap; }
.chip .dot { width:7px; height:7px; border-radius:50%; background:currentColor; }
.chip.ok { color:var(--ink); }
.chip.warn { color:var(--ink); border-color:var(--ink); }
.chip.warn .dot { background:#fff; box-shadow:inset 0 0 0 2px var(--ink); }

/* people */
.panel.flush { margin-top:20px; }
.people { display:grid; gap:14px; grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr)); }
.person { display:flex; gap:14px; padding:16px; border:1px solid var(--line); border-radius:var(--r); background:var(--card); min-width:0; }
.avatar { width:44px; height:44px; flex:none; border-radius:50%; display:grid; place-items:center; background:var(--ink); color:#fff; font-weight:700; font-size:18px; }
.pmain { min-width:0; flex:1; }
.pname { font-weight:650; overflow-wrap:anywhere; }
.level { font-family:var(--mono); font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--faint); margin-left:4px; }
.pstatus { font-size:20px; font-weight:700; letter-spacing:-.01em; margin-top:2px; }
.pstatus.muted { color:var(--mut); font-size:15px; font-weight:500; }
.pfoot { margin-top:10px; }
.coords { margin-top:10px; display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px; }
.coords code { font-size:14px; }

/* sharing rows */
.row-card { display:flex; gap:12px 18px; align-items:center; justify-content:space-between; flex-wrap:wrap; padding:14px 0; border-bottom:1px solid var(--line); }
.row-card:last-child { border-bottom:0; }
.row-card .who { min-width:0; flex:1 1 200px; overflow-wrap:anywhere; }
.row-card .ctl { display:flex; flex-direction:column; align-items:stretch; gap:4px; flex:0 1 260px; }
.row-card .ctl .check { margin:4px 0 0; }
.switch { display:flex; gap:14px; align-items:flex-start; cursor:pointer; }
.switch input { position:absolute; opacity:0; width:1px; height:1px; }
.switch .track { flex:none; width:44px; height:26px; border-radius:999px; border:1px solid var(--line-strong); background:var(--panel2); position:relative; margin-top:2px; transition:background .15s; }
.switch .track::after { content:""; position:absolute; top:3px; left:3px; width:18px; height:18px; border-radius:50%; background:#fff; border:1px solid var(--line-strong); transition:transform .15s; }
.switch input:checked + .track { background:var(--ink); border-color:var(--ink); }
.switch input:checked + .track::after { transform:translateX(18px); border-color:var(--ink); }
.switch input:focus-visible + .track { outline:2px solid var(--ink); outline-offset:2px; }
.switch small { display:block; color:var(--mut); font-size:13.5px; }

/* lists and tables */
.items { list-style:none; margin:0; padding:0; }
.items li { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:12px 0; border-bottom:1px solid var(--line); }
.items li:last-child { border-bottom:0; }
.items li > div { min-width:0; overflow-wrap:anywhere; }
table { width:100%; border-collapse:collapse; font-size:14.5px; }
th,td { text-align:left; padding:11px 10px; border-bottom:1px solid var(--line); vertical-align:middle; }
th { color:var(--faint); font-weight:500; font-size:11px; text-transform:uppercase; letter-spacing:.08em; font-family:var(--mono); }
td.m { font-family:var(--mono); color:var(--mut); }
td.wrap { overflow-wrap:anywhere; word-break:break-word; }
td.act { text-align:right; }
td select { min-width:120px; }
tr:last-child td { border-bottom:0; }

/* secrets, devices */
.secret { position:relative; background:var(--panel2); padding:12px 14px; border-radius:var(--r-sm); border:1px solid var(--ink); margin-top:10px; font-size:13px; }
.secret .lab { color:var(--mut); font-size:11px; text-transform:uppercase; letter-spacing:.1em; display:block; margin-bottom:6px; font-family:var(--mono); }
.secret code { display:block; word-break:break-all; margin-bottom:8px; }
.secret pre { margin:0 0 8px; white-space:pre-wrap; word-break:break-all; font-size:12.5px; }
.pair { display:flex; gap:24px; flex-wrap:wrap; align-items:flex-start; margin-top:18px; }
.qr { width:240px; max-width:100%; flex:none; background:#fff; border:1px solid var(--line-strong); border-radius:var(--r-sm); padding:8px; }
.qr svg { display:block; width:100%; height:auto; }
.pair-steps { flex:1 1 260px; min-width:0; margin-top:14px; }
.steps { margin:0; padding-left:22px; }
.steps li { margin:0 0 10px; }
.ws-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap; }
.ws-name { font-size:24px; font-weight:700; letter-spacing:-.01em; overflow-wrap:anywhere; }

#toast { position:fixed; bottom:26px; left:50%; transform:translateX(-50%) translateY(8px); max-width:calc(100vw - 32px); background:var(--ink); color:var(--on-accent); border:1px solid var(--ink); padding:12px 18px; border-radius:11px; opacity:0; transition:.2s; pointer-events:none; font-size:14.5px; box-shadow:0 18px 44px -16px rgba(0,0,0,.5); z-index:30; }
#toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
#toast.err { background:#fff; color:var(--ink); border-left:4px solid var(--ink); }

.tabbar, .sheet { display:none; }

@media (max-width:900px) {
  .shell { grid-template-columns:minmax(0,1fr); }
  .rail { position:sticky; top:0; z-index:10; height:auto; flex-direction:row; align-items:center; border-right:0; border-bottom:1px solid var(--line); padding:10px 16px; }
  .brand { padding:0; }
  .brand .mark { width:30px; height:30px; font-size:15px; }
  .nav { display:none; }
  .foot { margin:0 0 0 auto; flex-direction:row; align-items:center; gap:10px; min-width:0; }
  .who-name { max-width:34vw; }
  main { padding:20px 16px calc(var(--tabbar-h) + 32px); }
  body[data-mode=gate] main { padding-bottom:40px; }
  .tabbar { display:flex; position:fixed; bottom:0; left:0; right:0; z-index:20; height:var(--tabbar-h); background:#fff; border-top:1px solid var(--line); padding:0 4px env(safe-area-inset-bottom); }
  .tabbar a, .tabbar button { flex:1; min-width:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px; background:none; border:0; color:var(--mut); text-decoration:none; font-size:11px; padding:6px 2px; }
  .tabbar .ic { font-size:18px; line-height:1; }
  .tabbar span:last-child { max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tabbar .on { color:var(--ink); font-weight:650; }
  .sheet { display:block; position:fixed; left:0; right:0; bottom:var(--tabbar-h); z-index:19; background:#fff; border-top:1px solid var(--line-strong); box-shadow:0 -18px 40px -24px rgba(0,0,0,.35); padding:10px 12px 14px; }
  .sheet.hidden { display:none !important; }
  .vhead h1 { font-size:24px; }
  .gate { margin-top:4vh; padding:28px 20px; }
  .readout { padding:22px 20px; }
  .rd-main .status { font-size:30px; }
  .rd-actions { flex:1 1 100%; }
  .panel { padding:18px 16px; }
}

@media (max-width:640px) {
  table.rt thead { display:none; }
  table.rt, table.rt tbody, table.rt tr, table.rt td { display:block; width:100%; }
  table.rt tr { padding:10px 0; border-bottom:1px solid var(--line); }
  table.rt tr:last-child { border-bottom:0; }
  table.rt td { border:0; padding:3px 0; display:flex; justify-content:space-between; align-items:center; gap:12px; text-align:right; }
  table.rt td::before { content:attr(data-label); color:var(--faint); font-family:var(--mono); font-size:11px; text-transform:uppercase; letter-spacing:.08em; text-align:left; flex:none; }
  table.rt td.act { justify-content:flex-end; padding-top:6px; }
  table.rt td.act::before { content:none; }
  table.rt td small { text-align:right; }
  .codes { grid-template-columns:minmax(0,1fr); }
  .lang button { padding:5px 10px; }
  .row-card .ctl { flex:1 1 100%; }
}
`;
