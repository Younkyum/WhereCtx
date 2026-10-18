/**
 * What `astryx theme add neutral` generates, minus the theme's fonts.css: that
 * file imports Figtree from Google Fonts, which the CSP (and self-hosting)
 * rule out. The same faces come from @fontsource, bundled with the page.
 */

import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "@astryxdesign/theme-neutral/theme.css";
import "@fontsource/figtree/latin-400.css";
import "@fontsource/figtree/latin-500.css";
import "@fontsource/figtree/latin-600.css";
import "@fontsource/figtree/latin-700.css";

export const theme = neutralTheme;
