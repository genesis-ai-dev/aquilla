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

const mockHasAuthHintCookie = vi.fn()
vi.mock("@/lib/frontier/session-store", () => ({
  hasAuthHintCookie: () => mockHasAuthHintCookie(),
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
  mockHasAuthHintCookie.mockReturnValue(false)
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
