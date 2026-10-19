import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The dashboard builds to dist/web, which the server serves at /dashboard/.
 * Nothing is inlined: no data: assets (img-src 'self') and no inline module
 * preload polyfill (script-src 'self').
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/dashboard/",
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../dist/web", import.meta.url)),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    // The dashboard, and the frame its maps are drawn in (the only page that loads a provider's script).
    rollupOptions: { input: { index: fileURLToPath(new URL("index.html", import.meta.url)), map: fileURLToPath(new URL("map.html", import.meta.url)) } },
    // React and the design system are most of the main chunk; this is one page, so splitting buys nothing.
    chunkSizeWarningLimit: 1000,
  },
  server: {
    proxy: { "/v1": "http://localhost:8787" },
  },
});
