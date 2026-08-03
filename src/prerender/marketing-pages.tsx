// Build-time render targets for the standalone marketing pages.
//
// `scripts/prerender-marketing.ts` bundles this module for Node (a small
// vite --ssr build), renders each page with react-dom/server, and injects the
// markup into the matching `dist/*.html`. Crawlers, link unfurlers, and no-JS
// visitors then get the whole page instead of the mount stub.
//
// This is a *static fallback*, not hydration: the client entries still call
// createRoot(), which clears the container and renders the live, interactive
// page over it. That keeps browser-only state (theme from sessionStorage, the
// aq_hint auth cookie) free to differ from the prerender without hydration
// mismatches — at the cost of the markup being painted twice.
//
// Keys must match the vite build inputs in vite.config.ts.
import type { ReactElement } from "react"
import { BrandProvider } from "@/branding/BrandProvider"
import { MARKETING_PAGE_IDS, type MarketingPageId } from "./pages"
import { Homepage } from "@/pages/Homepage/Homepage"
import { BibleTranslationLanding } from "@/pages/Homepage/BibleTranslationLanding"
import { BetaPage } from "@/pages/Beta/BetaPage"
import { ComeAndSeeCaseStudy } from "@/pages/CaseStudy/ComeAndSee"
import { BiblicaCaseStudy } from "@/pages/CaseStudy/Biblica"

const PAGES: Record<MarketingPageId, () => ReactElement> = {
  homepage: () => <Homepage />,
  "bible-translation": () => <BibleTranslationLanding />,
  beta: () => <BetaPage />,
  "case-study": () => <ComeAndSeeCaseStudy />,
  "case-study-biblica": () => <BiblicaCaseStudy />,
}

export { MARKETING_PAGE_IDS, type MarketingPageId }

/** The element the prerender script renders for one build entry. */
export function marketingPageElement(id: MarketingPageId): ReactElement {
  return <BrandProvider>{PAGES[id]()}</BrandProvider>
}
