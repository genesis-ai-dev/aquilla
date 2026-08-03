/**
 * AQU-702: Homepage links to the help documentation
 *
 * The main marketing site (aquilla.app, served as homepage.html to signed-out
 * visitors) must expose a clearly visible link to the help docs
 * (help.aquilla.app). It must be reachable logged-out and present on the mobile
 * layout — the nav links are hidden below 860px, so a footer link is the
 * mobile-guaranteed affordance. This test guards both:
 *   - at least one docs link exists and points at the docs site
 *   - a docs link lives in the footer (which stays visible on mobile), not only
 *     in the mobile-hidden nav.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { Homepage } from "./Homepage"

vi.mock("@/branding/use-brand", () => ({
  useBrand: () => ({
    app: { name: "Aquilla", tagline: "Tagline." },
    logo: { Mark: () => null },
    deploy: { domain: "aquilla.app" },
  }),
}))

vi.mock("./MultimodalWorkspace", () => ({ MultimodalWorkspace: () => null }))
vi.mock("./LanguageBlitz", () => ({ LanguageBlitz: () => null, LanguageMarquee: () => null }))
vi.mock("@/components/HealthRing", () => ({ HealthRing: () => null }))
vi.mock("./homepage.css", () => ({}))

vi.mock("@/lib/frontier/session-store", () => ({
  // The homepage itself no longer reads identity while rendering — it's
  // prerendered and edge-cached, so its markup can't depend on the visitor.
  // AppEntryBanner resolves the session after mount instead, which is why this
  // mock has to provide loadActiveSession. Returning null keeps the banner off
  // so these assertions see the signed-out page.
  loadActiveSession: () => Promise.resolve(null),
}))

function renderHomepage() {
  return render(
    <MemoryRouter>
      <Homepage />
    </MemoryRouter>,
  )
}

const DOCS_URL = "https://help.aquilla.app"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("Homepage — help documentation link (AQU-702)", () => {
  it("exposes at least one link to the help docs site", () => {
    renderHomepage()
    const docsLinks = screen
      .getAllByRole("link")
      .filter((a) => a.getAttribute("href") === DOCS_URL)
    expect(docsLinks.length).toBeGreaterThan(0)
  })

  it("includes a docs link in the footer, which stays visible on mobile", () => {
    const { container } = renderHomepage()
    const footer = container.querySelector("footer")
    expect(footer).not.toBeNull()
    const footerDocsLinks = within(footer as HTMLElement)
      .getAllByRole("link")
      .filter((a) => a.getAttribute("href") === DOCS_URL)
    expect(footerDocsLinks.length).toBeGreaterThan(0)
  })
})
