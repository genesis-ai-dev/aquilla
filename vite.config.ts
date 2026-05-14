/// <reference types="vitest" />
import path from "node:path"
import { defineConfig } from "vite"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import babel from "@rolldown/plugin-babel"
import tailwindcss from "@tailwindcss/vite"
import { nodePolyfills } from "vite-plugin-node-polyfills"
import { brandingHtmlPlugin } from "./scripts/vite-html-branding"
import { BRAND_DATA, BRAND_DATA_IDS } from "./apps/workspace/src/branding/brands/data"
import type { BrandId } from "./apps/workspace/src/branding/types"

// Phase 3a-final: the workspace SPA's source has moved to
// `apps/workspace/src/`. The repo root still drives the Vite build for two
// callers:
//
//   1. Cloudflare Pages CI (`.github/workflows/deploy.yml`) — runs
//      `npm run build` at root and deploys `dist/` to the existing Pages
//      project. Eventually this migrates to the per-app Worker (Workers
//      Assets via apps/workspace/src/worker.ts); until then the root
//      build remains the entry point.
//
//   2. Tauri (`src-tauri/tauri.conf.json`) — points `frontendDist` at
//      `../dist` and `beforeDevCommand` at `npm run dev`.
//
// This config sets `root: apps/workspace` so the new index.html /
// main.tsx are picked up, but emits to the repo-root `dist/` for the
// callers above. The companion `apps/workspace/vite.config.ts` is the
// in-app build (Workers Assets path) and is what `pnpm --filter
// @aquilla/workspace build` invokes.

function resolveBuildBrand(): BrandId {
  const raw = process.env.BRAND ?? "aquilla"
  if ((BRAND_DATA_IDS as string[]).includes(raw)) return raw as BrandId
  console.warn(`[branding] unknown BRAND="${raw}"; falling back to aquilla`)
  return "aquilla"
}

const brandId = resolveBuildBrand()
const brand = BRAND_DATA[brandId]

export default defineConfig(({ mode }) => ({
  root: path.resolve(__dirname, "apps/workspace"),
  // With root: apps/workspace, Vite's default publicDir would be
  // apps/workspace/public/ (which doesn't exist). Point it at the
  // repo-root public/ so favicons, OG images, and _redirects (which
  // Cloudflare Pages reads at the edge for the apex `/` → `/projects`
  // bounce) reach dist/.
  publicDir: path.resolve(__dirname, "public"),
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_"],
  define: {
    "import.meta.env.VITE_BRAND": JSON.stringify(brandId),
  },
  server: {
    // Bind to 127.0.0.1 explicitly; "localhost" can resolve to ::1 on
    // macOS, which Vite then can't bind, leaving Tauri's HTTP probe
    // hanging.
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    hmr: { protocol: "ws", host: "127.0.0.1", port: 1421 },
    watch: {
      ignored: [
        "**/src-tauri/**",
        "**/.worktrees/**",
        "**/.claude/worktrees/**",
      ],
    },
  },
  plugins: [
    react(),
    ...(mode === "test" ? [] : [babel({ presets: [reactCompilerPreset()] })]),
    tailwindcss(),
    nodePolyfills({
      include: ["crypto", "buffer", "stream", "util", "events", "path"],
      globals: { Buffer: true, global: true, process: true },
    }),
    brandingHtmlPlugin(brand),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "apps/workspace/src"),
    },
  },
  optimizeDeps: {
    include: [
      "vite-plugin-node-polyfills/shims/buffer",
      "vite-plugin-node-polyfills/shims/global",
      "vite-plugin-node-polyfills/shims/process",
      "@base-ui/react/button",
      "@base-ui/react/dialog",
      "@base-ui/react/input",
      "@base-ui/react/menu",
      "@base-ui/react/scroll-area",
      "@huggingface/transformers",
      "kokoro-js",
    ],
  },
  build: {
    // Emit to repo-root dist/ — the Cloudflare Pages deploy and Tauri
    // both expect the bundle there.
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        manualChunks: (id: string) => {
          if (!id.includes("node_modules")) return
          if (
            id.includes("/yjs/") ||
            id.includes("/y-indexeddb/") ||
            id.includes("/y-partyserver/") ||
            id.includes("/partyserver/")
          )
            return "yjs"
          if (id.includes("/isomorphic-git/")) return "git"
          if (id.includes("/@tiptap/")) return "tiptap"
          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("/react-router")
          )
            return "react"
        },
      },
    },
  },
  test: {
    environment: "happy-dom",
    setupFiles: [path.resolve(__dirname, "apps/workspace/src/test-setup.ts")],
    passWithNoTests: true,
    exclude: [
      "**/node_modules/**",
      "dist/**",
      ".worktrees/**",
      ".claude/worktrees/**",
      "e2e/**",
      // Each worker has its own vitest config + local node_modules.
      // Running their tests from root pulls in worker-local deps the
      // root install doesn't have. deploy-workers.yml runs each worker's
      // tests in its own directory.
      "apps/frontier-server/**",
      "chat-worker/**",
      "signaling/**",
      "sync-worker/**",
      // Other apps + packages have their own vitest configs + workspace-
      // aware resolution. CI runs per-app tests separately.
      "apps/billing/**",
      "apps/export/**",
      "apps/front-door/**",
      "apps/import/**",
      "apps/login/**",
      "apps/migrate/**",
      "apps/org/**",
      "apps/projects/**",
      "apps/reset/**",
      "apps/signup/**",
      "packages/**",
    ],
  },
}))
