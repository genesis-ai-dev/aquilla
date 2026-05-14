import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"

// Workspace SPA — AD-11's deliberate SPA exception (the only app that isn't
// task-flow-scoped). Mounted at /w/* per routes.json.
//
// Phase 3a-shell: config only; src/ extraction lands after Phase 2c-β.
//
// `base: "/w/"` ensures Vite emits asset URLs relative to /w/ so the same
// bundle works regardless of which `pr-N.<domain>` it deploys behind.
export default defineConfig({
  base: "/w/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
})
