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
    // React and the design system are most of the main chunk; this is one page, so splitting buys nothing. Leaflet is its own chunk, loaded with the first map.
    chunkSizeWarningLimit: 1100,
  },
  server: {
    proxy: { "/v1": "http://localhost:8787" },
  },
});
