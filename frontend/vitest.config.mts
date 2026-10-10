import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // Tests don't need Tailwind; an inline config stops Vite loading postcss.config.mjs when a
  // component imports CSS (leaflet.css).
  css: { postcss: { plugins: [] } },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src/", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
  },
});
