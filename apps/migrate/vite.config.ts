/// <reference types="vitest" />
import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// Base-path discipline (spec §21-monorepo.md): every app is mounted under
// /<slug>/, so Vite emits asset URLs relative to that base.
export default defineConfig({
  base: "/migrate/",
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist" },
  test: {
    environment: "happy-dom",
    passWithNoTests: true,
  },
})
