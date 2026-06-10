import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import App from "./App"
import "./index.css"
import { brand } from "./branding/current-brand"
import { applyTheme } from "./branding/apply-theme"
import { BrandProvider } from "./branding/BrandProvider"
import { ThemeModeProvider } from "./branding/ThemeMode"
import { ColorThemeProvider } from "./branding/ColorTheme"
import { captureException } from "@/components/ErrorBoundary"
// Buffer/crypto/etc. provided by vite-plugin-node-polyfills (see vite.config.ts)

applyTheme(brand)
document.title = brand.app.htmlTitle

// RES-3: Global error hooks — catch unhandled errors and promise rejections
// that escape component boundaries (e.g., setTimeout callbacks, promise chains
// started outside React). Attached here, after posthog.ts has run its init.
const CHUNK_RELOAD_KEY = "aq:chunk-reload-attempted"
const CHUNK_PATTERNS = [
  "Failed to fetch dynamically imported module",
  "Importing a module script failed",
  "Loading chunk",
  "ChunkLoadError",
]

// N2: the reload-once flag exists to break reload LOOPS (a chunk that fails
// again immediately after the reload). It must clear after a SUCCESSFUL boot,
// or the second chunk failure in a session (e.g. a new deploy hours later) is
// silently swallowed instead of getting its own one-shot reload. Lazy chunks
// load on navigation — after `load` — so clearing here cannot re-arm a loop:
// each reload only re-arms once the page has fully booted again.
function clearChunkReloadFlag() {
  sessionStorage.removeItem(CHUNK_RELOAD_KEY)
}
if (document.readyState === "complete") {
  clearChunkReloadFlag()
} else {
  window.addEventListener("load", clearChunkReloadFlag, { once: true })
}

function isChunkMsg(msg: string): boolean {
  return CHUNK_PATTERNS.some((p) => msg.includes(p))
}

window.addEventListener("error", (event) => {
  const err = event.error ?? new Error(event.message)
  if (import.meta.env.DEV) {
    console.error("[global error]", err)
    return // let the browser's own devtools handle it in dev
  }
  if (isChunkMsg(err instanceof Error ? err.message : String(err))) {
    if (!sessionStorage.getItem(CHUNK_RELOAD_KEY)) {
      sessionStorage.setItem(CHUNK_RELOAD_KEY, "1")
      window.location.reload()
    }
    return
  }
  captureException(err)
})

window.addEventListener("unhandledrejection", (event) => {
  const err = event.reason instanceof Error ? event.reason : new Error(String(event.reason))
  if (import.meta.env.DEV) {
    console.error("[unhandledrejection]", err)
    return
  }
  if (isChunkMsg(err.message)) {
    if (!sessionStorage.getItem(CHUNK_RELOAD_KEY)) {
      sessionStorage.setItem(CHUNK_RELOAD_KEY, "1")
      window.location.reload()
    }
    return
  }
  captureException(err)
})

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60_000,      // 5 min — Frontier project lists rarely change mid-session
      gcTime: 30 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrandProvider>
        <ThemeModeProvider>
          <ColorThemeProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </ColorThemeProvider>
        </ThemeModeProvider>
      </BrandProvider>
    </QueryClientProvider>
  </StrictMode>
)
