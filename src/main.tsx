import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import App from "./App"
import "./index.css"
import { brand } from "./branding/current-brand"
import { applyTheme } from "./branding/apply-theme"
import { BrandProvider } from "./branding/BrandProvider"
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrandProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </BrandProvider>
    </QueryClientProvider>
  </StrictMode>
)
