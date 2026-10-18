/**
 * Dashboard copy in English and Korean, served as /dashboard/i18n.js. The
 * Korean table is typed against the English keys, so a missing or extra key
 * fails the build. `{name}` placeholders are filled by t() in core.js.
 */

import { EN, type I18nKey } from "./i18n.en.js";
import { KO } from "./i18n.ko.js";

export type { I18nKey };

export const I18N: { en: Record<I18nKey, string>; ko: Record<I18nKey, string> } = { en: EN, ko: KO };

export const I18N_JS = `export var I18N = ${JSON.stringify(I18N)};\n`;
