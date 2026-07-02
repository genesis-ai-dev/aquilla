// Standalone entry for the /beta marketing page (built to dist/beta.html).
// The aquilla-web Worker serves this file at `/beta` always. See worker/index.ts.
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import { brand } from "./branding/current-brand"
import { applyTheme } from "./branding/apply-theme"
import { BrandProvider } from "./branding/BrandProvider"
import { BetaPage } from "./pages/Beta/BetaPage"
import { DelegatedTooltipLayer } from "./components/ui/tooltip"

applyTheme(brand)
document.title = `Public beta — ${brand.app.name}`

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrandProvider>
      <BetaPage />
      <DelegatedTooltipLayer />
    </BrandProvider>
  </StrictMode>,
)
