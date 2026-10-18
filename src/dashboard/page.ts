/**
 * The dashboard's HTML shell. It holds no data and no inline script: the
 * page loads /dashboard/style.css and the /dashboard/app.js module, which
 * signs the person in with a passkey (session cookie) and renders every view.
 */

export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="light" />
<title>WhereCtx</title>
<link rel="stylesheet" href="/dashboard/style.css" />
<script type="module" src="/dashboard/app.js"></script>
</head>
<body data-mode="loading">
<div class="shell">
  <aside class="rail">
    <div class="brand"><span class="mark" aria-hidden="true">&#9673;</span><div><b>WhereCtx</b><small class="micro" data-i18n="app.subtitle">presence</small></div></div>
    <nav class="nav" id="nav" aria-label="Main"></nav>
    <div class="foot">
      <div id="who"></div>
      <div class="lang" role="group" aria-label="Language"><button type="button" data-lang="en">EN</button><button type="button" data-lang="ko">한국어</button></div>
    </div>
  </aside>
  <main>
    <div id="gate" class="hidden"></div>
    <div id="view" class="hidden"></div>
    <noscript><div class="gate"><h1>WhereCtx</h1><p class="lead">This dashboard needs JavaScript.</p></div></noscript>
  </main>
</div>
<nav class="tabbar" id="tabbar" aria-label="Main"></nav>
<div id="more" class="sheet hidden"></div>
<div id="toast" role="status" aria-live="polite"></div>
</body>
</html>`;
