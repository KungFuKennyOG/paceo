import { defineConfig } from "vitest/config";

// Kept separate from vite.config.ts so tests never load the PWA plugin.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
    css: false,
  },
});
