import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // NOTE: the TinyH264 software-decoder fallback only works in production
  // builds — Vite dev pre-bundling breaks its `new URL("./worker.js", ...)`
  // worker loading. Dev is localhost (secure context) and uses WebCodecs
  // anyway; LAN/insecure viewers use the built app served by the server.
  worker: { format: "es" },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // Cache the app shell only — media and API traffic must never touch a SW cache.
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg}"],
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/ws\//],
        runtimeCaching: [],
      },
      manifest: {
        name: "speedcrcpy",
        short_name: "speedcrcpy",
        description: "Remote control your Android devices from any browser",
        display: "standalone",
        // No `orientation`: an installed PWA that declares one overrides the
        // system auto-rotate switch for itself, so this app rotated on a phone
        // whose owner had rotation locked and every other app stayed put.
        // Which way the screen faces is the user's decision, not this app's.
        background_color: "#101418",
        theme_color: "#101418",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
    }),
  ],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8000", changeOrigin: false },
      "/ws": { target: "ws://localhost:8000", ws: true },
    },
  },
});
