/// <reference types="vitest" />
import path from "path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// AD-11 base-path discipline: this app mounts at /login/*. Setting `base`
// here makes asset URLs (`<script src=…>`, `<link rel="stylesheet" …>`)
// resolve correctly when the bundle is served from /login/. The router
// also sets basename="/login" (see App.tsx) so internal navigation stays
// inside the mounted path.

export default defineConfig({
  base: "/login/",
  envPrefix: ["VITE_"],
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    environment: "happy-dom",
    setupFiles: ["./src/test-setup.ts"],
    passWithNoTests: true,
    globals: false,
  },
})
