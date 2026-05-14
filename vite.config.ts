/// <reference types="vitest" />
import path from "path"
import { defineConfig } from "vite"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import babel from "@rolldown/plugin-babel"
import tailwindcss from "@tailwindcss/vite"
import { nodePolyfills } from "vite-plugin-node-polyfills"
import { brandingHtmlPlugin } from "./scripts/vite-html-branding"
import { BRAND_DATA, BRAND_DATA_IDS } from "./src/branding/brands/data"
import type { BrandId } from "./src/branding/types"

function resolveBuildBrand(): BrandId {
  const raw = process.env.BRAND ?? "aquilla"
  if ((BRAND_DATA_IDS as string[]).includes(raw)) return raw as BrandId
  console.warn(`[branding] unknown BRAND="${raw}"; falling back to aquilla`)
  return "aquilla"
}

const brandId = resolveBuildBrand()
const brand = BRAND_DATA[brandId]

export default defineConfig(({ mode }) => ({
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
    watch: {
      // Worktrees contain their own copies of tsconfig.json; any touch there
      // triggers Vite's "changed tsconfig" path which clears the cache and
      // forces a full reload — that's the white-screen on project click.
      ignored: ["**/src-tauri/**", "**/.worktrees/**", "**/.claude/worktrees/**"],
    },
  },
  plugins: [
    react(),
    // React Compiler is RC and expensive at compile time. Skip it for the
    // test build — the compiler isn't what we're testing, and including it
    // turned the E2E orchestrator into a memory hog on dev machines.
    ...(mode === "test" ? [] : [babel({ presets: [reactCompilerPreset()] })]),
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
  optimizeDeps: {
    // Shims are injected by vite-plugin-node-polyfills at transform time, so
    // Vite's static scanner misses them. Pre-including them avoids a second
    // optimization pass that re-hashes every shared chunk mid-page-load.
    include: [
      "vite-plugin-node-polyfills/shims/buffer",
      "vite-plugin-node-polyfills/shims/global",
      "vite-plugin-node-polyfills/shims/process",
      // Base UI sub-paths reachable only from ProjectWorkspace. Without
      // pre-inclusion, navigating from Dashboard → /project/:id triggers a
      // mid-flight re-optimize that re-hashes every shared chunk and forces
      // a reload (white screen).
      "@base-ui/react/button",
      "@base-ui/react/dialog",
      "@base-ui/react/input",
      "@base-ui/react/menu",
      "@base-ui/react/scroll-area",
      // Audio AI deps imported only inside Web Workers. Without pre-inclusion
      // the first transcription/TTS click triggers a mid-flight Vite re-
      // optimize, which forces a full page reload (white-screen) and kills
      // the in-progress model download. These are big — pre-bundling them
      // up front keeps the dev server boot a few seconds slower instead.
      "@huggingface/transformers",
      "kokoro-js",
    ],
  },
  build: {
    // Split large third-party deps out of the main bundle. Without this the
    // app bundle balloons past 2 MB, which trips Cloudflare Pages' asset
    // upload path (observed as repeated ECONNRESET at 26/27 files).
    rolldownOptions: {
      output: {
        manualChunks: (id: string) => {
          if (!id.includes("node_modules")) return
          if (id.includes("/yjs/") || id.includes("/y-indexeddb/") || id.includes("/y-partyserver/") || id.includes("/partyserver/")) return "yjs"
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
    exclude: [
      "**/node_modules/**",
      "dist/**",
      ".worktrees/**",
      ".claude/worktrees/**",
      "e2e/**",
      // Each worker has its own vitest config + local node_modules. Running
      // their tests from root pulls in worker-local deps the root install
      // doesn't have. deploy-workers.yml runs each worker's tests in its
      // own directory.
      "auth-worker/**",
      "chat-worker/**",
      "signaling/**",
      "sync-worker/**",
      // Apps + packages have their own vitest configs + workspace-aware
      // resolution. Running their tests from root would need workspace
      // package resolution (e.g. @aquilla/auth-client) which the root
      // node_modules doesn't carry — CI runs per-app tests separately.
      "apps/**",
      "packages/**",
    ],
  },
}))
