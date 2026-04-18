/// <reference types="vitest" />
import path from "path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { nodePolyfills } from "vite-plugin-node-polyfills"
import { brandingHtmlPlugin } from "./scripts/vite-html-branding"
import { BRAND_DATA, BRAND_DATA_IDS } from "./src/branding/brands/data"
import type { BrandId } from "./src/branding/types"

function resolveBuildBrand(): BrandId {
  const raw = process.env.BRAND ?? "codex"
  if ((BRAND_DATA_IDS as string[]).includes(raw)) return raw as BrandId
  console.warn(`[branding] unknown BRAND="${raw}"; falling back to codex`)
  return "codex"
}

const brandId = resolveBuildBrand()
const brand = BRAND_DATA[brandId]

export default defineConfig({
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_"],
  define: {
    "import.meta.env.VITE_BRAND": JSON.stringify(brandId),
  },
  server: {
    // Bind to 127.0.0.1 explicitly; "localhost" can resolve to ::1 on macOS,
    // which Vite then can't bind, leaving Tauri's HTTP probe hanging.
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    hmr: { protocol: "ws", host: "127.0.0.1", port: 1421 },
    watch: { ignored: ["**/src-tauri/**"] },
  },
  plugins: [
    react(),
    tailwindcss(),
    // isomorphic-git pulls in node:crypto, node:buffer, etc.
    nodePolyfills({
      include: ["crypto", "buffer", "stream", "util", "events", "path"],
      globals: { Buffer: true, global: true, process: true },
    }),
    brandingHtmlPlugin(brand),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // Split large third-party deps out of the main bundle. Without this the
    // app bundle balloons past 2 MB, which trips Cloudflare Pages' asset
    // upload path (observed as repeated ECONNRESET at 26/27 files).
    rolldownOptions: {
      output: {
        manualChunks: (id: string) => {
          if (!id.includes("node_modules")) return
          if (id.includes("/yjs/") || id.includes("/y-indexeddb/") || id.includes("/y-webrtc/")) return "yjs"
          if (id.includes("/isomorphic-git/")) return "git"
          if (id.includes("/@tiptap/")) return "tiptap"
          if (id.includes("/react/") || id.includes("/react-dom/") || id.includes("/react-router")) return "react"
        },
      },
    },
  },
  test: {
    environment: "happy-dom",
    setupFiles: ["./src/test-setup.ts"],
    passWithNoTests: true,
    exclude: ["**/node_modules/**", "dist/**", ".worktrees/**", ".claude/worktrees/**", "cors-proxy/**"],
  },
})
