import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const API_TARGET = process.env.PACEO_API_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      includeAssets: ["favicon.svg", "apple-touch-icon.png", "push-sw.js"],
      manifest: {
        name: "Paceo",
        short_name: "Paceo",
        description: "Running plans for a small crew of friends.",
        lang: "en",
        start_url: "/",
        scope: "/",
        // §2.1: iOS web push needs standalone (or fullscreen) and a Home Screen install.
        display: "standalone",
        orientation: "portrait",
        theme_color: "#16130f",
        background_color: "#f4f1ea",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "favicon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
        navigateFallback: "/index.html",
        // Never serve API calls from the cache.
        navigateFallbackDenylist: [/^\/api\//],
        // Web push + notification click handlers live in a plain script (public/push-sw.js).
        importScripts: ["push-sw.js"],
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
