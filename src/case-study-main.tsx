// Standalone entry for the Come and See case study (built to dist/case-study.html).
// The aquilla-web Worker serves this file at `/case-studies/come-and-see` always.
// See worker/index.ts.
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import { brand } from "./branding/current-brand"
import { applyTheme } from "./branding/apply-theme"
import { BrandProvider } from "./branding/BrandProvider"
import { ComeAndSeeCaseStudy } from "./pages/CaseStudy/ComeAndSee"
import { DelegatedTooltipLayer } from "./components/ui/tooltip"

applyTheme(brand)
document.title = `Come and See — ${brand.app.name}`

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrandProvider>
      <ComeAndSeeCaseStudy />
      <DelegatedTooltipLayer />
    </BrandProvider>
  </StrictMode>,
)
