/// <reference types="vitest" />
import path from "path"
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { defineConfig } from "vite"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import babel from "@rolldown/plugin-babel"
import tailwindcss from "@tailwindcss/vite"
import { nodePolyfills } from "vite-plugin-node-polyfills"
import { brandingHtmlPlugin } from "./scripts/vite-html-branding"
import { BRAND_DATA, BRAND_DATA_IDS } from "./src/branding/brands/data"
import type { BrandId } from "./src/branding/types"

// Cloudflare Pages exposes CF_PAGES_BRANCH / CF_PAGES_COMMIT_SHA in CI builds.
// Locally we fall back to git so dev shells still show something useful.
function git(args: string[]): string {
  try {
    return execFileSync("git", args, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim()
  } catch {
    return ""
  }
}
const pkgVersion = JSON.parse(readFileSync("./package.json", "utf8")).version as string
const buildBranch = process.env.CF_PAGES_BRANCH || git(["rev-parse", "--abbrev-ref", "HEAD"]) || "unknown"
const buildSha = (process.env.CF_PAGES_COMMIT_SHA || git(["rev-parse", "HEAD"])).slice(0, 7)

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
    "import.meta.env.VITE_BETA_FLAG": JSON.stringify(process.env.VITE_BETA_FLAG ?? "1"),
    __APP_VERSION__: JSON.stringify(pkgVersion),
    __APP_BRANCH__: JSON.stringify(buildBranch),
    __APP_SHA__: JSON.stringify(buildSha),
  },
  server: {
    // Bind to 127.0.0.1 explicitly; "localhost" can resolve to ::1 on
    // macOS, which Vite then can't bind, leaving Tauri's HTTP probe
    // hanging.
    host: "127.0.0.1",
    // Allow Vite's dev server to serve font files that live inside the pnpm
    // content-addressable store (node_modules/.pnpm/…). Without this entry,
    // requests for Geist Variable woff2 files return 403s in the browser
    // console during dev — alarming during screen-share demos. Production
    // builds inline/copy the files at build time, so this is dev-only.
    fs: {
      allow: [".", "node_modules/.pnpm"],
    },
    // Tauri owns 1420 for its webview shell and needs HMR on a separate
    // socket (1421). For plain web dev (`pnpm dev` / `pnpm dev:vite`) Vite
    // picks the port via --port (dev-stack passes 5173) and HMR rides on
    // the same socket — overriding it here would mismatch the bundled
    // client. `tauri dev` sets TAURI_ENV_PLATFORM, so gate on that.
    ...(process.env.TAURI_ENV_PLATFORM
      ? {
          port: 1420,
          strictPort: true,
          hmr: { protocol: "ws", host: "127.0.0.1", port: 1421 },
        }
      : {}),
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
    {
      name: "version-json",
      writeBundle() {
        mkdirSync("dist", { recursive: true })
        writeFileSync("dist/version.json", JSON.stringify({ sha: buildSha }))
      },
    },
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
    // hls.js (~508kB), dash.js (~961kB), and web-worker AI bundles (whisper,
    // kokoro, mms) are intentionally large and non-initial (lazy route or
    // worker). Raise the threshold so vite doesn't warn about things we
    // can't reasonably split further.
    chunkSizeWarningLimit: 1000,
    // Split large third-party deps out of the main bundle. Without this the
    // app bundle balloons past 2 MB, which trips Cloudflare Pages' asset
    // upload path (observed as repeated ECONNRESET at 26/27 files).
    rolldownOptions: {
      // Multi-page build: the SPA shell (index.html) and the standalone,
      // statically-served marketing homepage (homepage.html). The aquilla-web
      // Worker picks between them at the edge via the aq_hint cookie.
      input: {
        index: path.resolve(__dirname, "index.html"),
        homepage: path.resolve(__dirname, "homepage.html"),
        "bible-translation": path.resolve(__dirname, "bible-translation.html"),
        beta: path.resolve(__dirname, "beta.html"),
        "case-study": path.resolve(__dirname, "case-study.html"),
        "case-study-biblica": path.resolve(__dirname, "case-study-biblica.html"),
      },
      output: {
        // Keep source module names out of emitted chunk URLs. Brave/EasyList can
        // block app-critical chunks whose filenames look like tracking scripts,
        // which blanks the SPA before React mounts. Entry files keep their
        // configured page names.
        chunkFileNames: "assets/app-chunk-[hash].js",
        manualChunks: (id: string) => {
          if (!id.includes("node_modules")) return
          if (id.includes("/yjs/") || id.includes("/y-indexeddb/") || id.includes("/y-partyserver/") || id.includes("/partyserver/")) return "yjs"
          if (id.includes("/isomorphic-git/")) return "git"
          if (id.includes("/@tiptap/")) return "tiptap"
          if (id.includes("/react/") || id.includes("/react-dom/") || id.includes("/react-router")) return "react"
          // react-player coordination layer — hls.js and dash.js are already
          // split by rolldown into their own chunks (they're too large to merge).
          if (id.includes("/react-player/")) return "react-player"
          // lucide ships hundreds of icons; split it out so the main chunk isn't bloated
          if (id.includes("/lucide-react/") || id.includes("/lucide/")) return "lucide"
          // base-ui is a shared UI primitive layer — worth isolating
          if (id.includes("/@base-ui/")) return "base-ui"
          // tanstack query/virtual
          if (id.includes("/@tanstack/")) return "tanstack"
        },
      },
    },
  },
  test: {
    environment: "happy-dom",
    setupFiles: ["./src/test-setup.ts"],
    passWithNoTests: false,
    exclude: [
      "**/node_modules/**",
      "dist/**",
      ".worktrees/**",
      ".claude/worktrees/**",
      ".claire/**",
      "e2e/**",
      // Each worker has its own vitest config + local node_modules. Running
      // their tests from root pulls in worker-local deps the root install
      // doesn't have. deploy-workers.yml runs each worker's tests in its
      // own directory.
      "auth-worker/**",
      "sync-worker/**",
      "worker/**",
      // Parity-run acceptance/roundtrip suites run via `pnpm parity:score` /
      // `pnpm roundtrip:score` with parity/vitest.config.ts — rows there are
      // red by design until implemented, so they must not fail the default
      // suite.
      "parity/**",
    ],
  },
}))
