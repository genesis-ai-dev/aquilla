// Standalone entry for the marketing homepage (built to dist/homepage.html).
// The aquilla-web Worker serves this file at `/` for signed-out visitors and
// at `/homepage` always; the SPA (index.html) is served only once the
// aq_hint=1 cookie is present. See worker/index.ts.
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import { brand } from "./branding/current-brand"
import { applyTheme } from "./branding/apply-theme"
import { BrandProvider } from "./branding/BrandProvider"
import { Homepage } from "./pages/Homepage/Homepage"

applyTheme(brand)
document.title = brand.app.htmlTitle

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrandProvider>
      <Homepage />
    </BrandProvider>
  </StrictMode>,
)
