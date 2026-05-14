/// <reference types="vitest" />
import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  base: "/billing/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5175,
    strictPort: false,
  },
  build: {
    outDir: "dist/billing",
    emptyOutDir: true,
  },
  test: {
    environment: "happy-dom",
    passWithNoTests: true,
  },
})
