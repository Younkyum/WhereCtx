/**
 * Every file the dashboard serves besides its HTML page, by path under
 * /dashboard/. The browser loads app.js as an ES module; it imports the rest
 * by relative path, so this table is the whole client.
 */

import { ACCOUNT_JS } from "./client/account.js";
import { APP_JS } from "./client/app.js";
import { CORE_JS } from "./client/core.js";
import { DATA_JS } from "./client/data.js";
import { DEVICES_JS } from "./client/devices.js";
import { GATE_JS } from "./client/gate.js";
import { HOME_JS } from "./client/home.js";
import { LIB_JS } from "./client/lib.js";
import { SHARING_JS } from "./client/sharing.js";
import { WORKSPACE_JS } from "./client/workspace.js";
import { I18N_JS } from "./i18n.js";
import { DASHBOARD_CSS } from "./style.js";

export interface DashboardAsset {
  body: string;
  contentType: string;
}

const JS = "text/javascript; charset=utf-8";

export const DASHBOARD_ASSETS: Readonly<Record<string, DashboardAsset>> = {
  "app.js": { body: APP_JS, contentType: JS },
  "core.js": { body: CORE_JS, contentType: JS },
  "lib.js": { body: LIB_JS, contentType: JS },
  "i18n.js": { body: I18N_JS, contentType: JS },
  "gate.js": { body: GATE_JS, contentType: JS },
  "home.js": { body: HOME_JS, contentType: JS },
  "sharing.js": { body: SHARING_JS, contentType: JS },
  "data.js": { body: DATA_JS, contentType: JS },
  "devices.js": { body: DEVICES_JS, contentType: JS },
  "workspace.js": { body: WORKSPACE_JS, contentType: JS },
  "account.js": { body: ACCOUNT_JS, contentType: JS },
  "style.css": { body: DASHBOARD_CSS, contentType: "text/css; charset=utf-8" },
};
