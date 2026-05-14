/// <reference types="vitest" />
import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// Base-path discipline (spec §21-monorepo.md, AD-11):
// - Vite emits assets with the `/projects/` prefix.
// - <base> in index.html, React Router basename, and this base must agree.
// - Asset URLs in app code MUST go through Vite's bundler (import xPng from
//   "./x.png") so the prefix is applied automatically.
export default defineConfig({
  base: "/projects/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5174,
    strictPort: false,
  },
  build: {
    // Emit into dist/projects/ so the on-disk layout matches the URL
    // prefix Workers Routes claims (aquilla.app/projects/*). The Workers
    // Assets binding maps a request at /projects/foo.js to
    // <directory>/projects/foo.js — without the nested folder, every
    // /projects/assets/*.js request would fall through to the SPA-fallback
    // index.html and the page would load with broken script tags.
    outDir: "dist/projects",
    emptyOutDir: true,
  },
  test: {
    environment: "happy-dom",
    globals: false,
    passWithNoTests: true,
  },
})
