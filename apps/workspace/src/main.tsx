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
// Buffer/crypto/etc. provided by vite-plugin-node-polyfills (see vite.config.ts)

applyTheme(brand)
document.title = brand.app.htmlTitle

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

// The same workspace SPA bundle is served two ways in production:
//   - aquilla.app/w/*  → apps/workspace Worker (vite base /w/)
//   - aquilla.app/...  → legacy Cloudflare Pages bundle (vite base /)
// React Router's basename has to match whichever path the browser
// loaded under, so detect it at first paint by checking the URL prefix.
const ROUTER_BASENAME =
  typeof window !== "undefined" && window.location.pathname.startsWith("/w/")
    ? "/w"
    : "/"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrandProvider>
        <ThemeModeProvider>
          <BrowserRouter basename={ROUTER_BASENAME}>
            <App />
          </BrowserRouter>
        </ThemeModeProvider>
      </BrandProvider>
    </QueryClientProvider>
  </StrictMode>
)
