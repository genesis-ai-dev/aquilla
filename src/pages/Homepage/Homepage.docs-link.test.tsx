/**
 * AQU-702: Homepage links to the help documentation
 *
 * The main marketing site (aquilla.app, served as homepage.html to signed-out
 * visitors) must expose a clearly visible link to the help docs
 * (help.aquilla.app). Docs is not a mid-nav item — signed-in visitors get a
 * Docs button in the nav CTA, and everyone gets a footer link (the
 * mobile-guaranteed affordance, since `.aq-nav-links` hide below 860px).
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

  it("does not duplicate Docs in the mid-nav; signed-in visitors use the CTA button", () => {
    const { container } = renderHomepage()
    const midNav = container.querySelector(".aq-nav-links")
    expect(midNav).not.toBeNull()
    expect(
      within(midNav as HTMLElement).queryByRole("link", { name: /^docs$/i }),
    ).toBeNull()
  })
})
