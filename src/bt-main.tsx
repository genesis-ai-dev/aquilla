// Standalone entry for the unlisted Bible-translation (BT) landing page.
// Direct-link only — noindex via bible-translation.html's <meta> tag and
// robots.txt; never linked from nav, footer, or any sitemap. See
// docs/superpowers/specs/2026-07-07-generic-homepage-bt-unlisted-design.md
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import { brand } from "./branding/current-brand"
import { applyTheme } from "./branding/apply-theme"
import { BrandProvider } from "./branding/BrandProvider"
import { BibleTranslationLanding } from "./pages/Homepage/BibleTranslationLanding"

applyTheme(brand)
document.title = brand.app.htmlTitle

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrandProvider>
      <BibleTranslationLanding />
    </BrandProvider>
  </StrictMode>,
)
