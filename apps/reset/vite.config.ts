/// <reference types="vitest" />
import path from "path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  base: "/reset/",
  envPrefix: ["VITE_"],
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "dist/reset",
    emptyOutDir: true,
  },
  test: {
    environment: "happy-dom",
    setupFiles: ["./src/test-setup.ts"],
    passWithNoTests: true,
    globals: false,
  },
})
