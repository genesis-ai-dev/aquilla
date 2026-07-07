// Standalone entry for the Biblica Global Publishing case study (built to
// dist/case-study-biblica.html). The aquilla-web Worker serves this file at
// `/case-studies/biblica` always. See worker/index.ts.
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import { brand } from "./branding/current-brand"
import { applyTheme } from "./branding/apply-theme"
import { BrandProvider } from "./branding/BrandProvider"
import { BiblicaCaseStudy } from "./pages/CaseStudy/Biblica"

applyTheme(brand)
document.title = `Biblica Global Publishing — ${brand.app.name}`

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrandProvider>
      <BiblicaCaseStudy />
    </BrandProvider>
  </StrictMode>,
)
