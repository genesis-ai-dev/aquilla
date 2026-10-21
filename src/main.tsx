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
import { FontSizeProvider } from "./branding/FontSize"
import { ErrorBoundary } from "./components/ErrorBoundary"
import { I18nProvider } from "./lib/i18n/I18nProvider"
import { loadCatalog } from "./lib/i18n/messages"
import { detectInitialLocale, readStoredLocale } from "./lib/i18n/store"
import { AccountsProvider } from "./hooks/useAccounts"
// Buffer/crypto/etc. provided by vite-plugin-node-polyfills (see vite.config.ts)

applyTheme(brand)
document.title = brand.app.htmlTitle

// Accent presets were retired in favor of the brand's neutral light/dark
// palettes. Clear the old DOM override so an existing session cannot retain
// a tinted workspace after upgrading.
document.documentElement.removeAttribute("data-color-theme")


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

// AQU-2090: only English ships with the app. A visitor in another language gets
// their catalog before the first paint, so the app doesn't flash English, but
// never waits more than 3 s for it: past that it starts in English and switches
// when the catalog lands.
const startingLocale = detectInitialLocale(readStoredLocale(), navigator.language)
const startingCatalog = Promise.race([
  loadCatalog(startingLocale).catch(() => undefined),
  new Promise((resolve) => setTimeout(resolve, 3000)),
])

void startingCatalog.then(() => createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AccountsProvider>
          <I18nProvider>
            <BrandProvider>
              <ThemeModeProvider>
                <FontSizeProvider>
                  <BrowserRouter>
                    <App />
                  </BrowserRouter>
                </FontSizeProvider>
              </ThemeModeProvider>
            </BrandProvider>
          </I18nProvider>
        </AccountsProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>
))
