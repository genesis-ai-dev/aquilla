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
import { ErrorBoundary } from "./components/ErrorBoundary"
import { I18nProvider } from "./lib/i18n/I18nProvider"
// Buffer/crypto/etc. provided by vite-plugin-node-polyfills (see vite.config.ts)

applyTheme(brand)
document.title = brand.app.htmlTitle

// Accent presets were retired in favor of the brand's neutral light/dark
// palettes. Clear both the old DOM override and its device-scoped preference
// so an existing session cannot retain a tinted workspace after upgrading.
document.documentElement.removeAttribute("data-color-theme")
try {
  window.localStorage.removeItem("codex-color-theme")
} catch {
  // Storage can be unavailable in hardened/private browser contexts.
}


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
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <BrandProvider>
            <ThemeModeProvider>
              <BrowserRouter>
                <App />
              </BrowserRouter>
            </ThemeModeProvider>
          </BrandProvider>
        </I18nProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>
)
