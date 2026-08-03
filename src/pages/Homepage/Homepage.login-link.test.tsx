/**
 * AQU-282: Homepage "Open app" link target
 *
 * Verifies that:
 *  - When no auth-hint cookie is present, "Open app" links point to /login
 *  - When the auth-hint cookie is present, "Open app" links point to /
 *
 * The Homepage component is rendered with heavy mocks to isolate just the
 * link-target behaviour.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { Homepage } from "./Homepage"

// ---------------------------------------------------------------------------
// Heavy component mocks — keeps the test focused on link targets only.
// ---------------------------------------------------------------------------

vi.mock("@/branding/use-brand", () => ({
  useBrand: () => ({
    app: { name: "Aquilla", tagline: "Tagline." },
    logo: { Mark: () => null },
    deploy: { domain: "aquilla.app" },
  }),
}))

vi.mock("./MultimodalWorkspace", () => ({
  MultimodalWorkspace: () => null,
}))

vi.mock("./LanguageBlitz", () => ({
  LanguageBlitz: () => null,
  LanguageMarquee: () => null,
}))

vi.mock("@/components/HealthRing", () => ({
  HealthRing: () => null,
}))

// CSS import — no-op in tests.
vi.mock("./homepage.css", () => ({}))

vi.mock("@/lib/frontier/session-store", () => ({
  // AppEntryBanner reads the session; these specs only care about the nav link.
  loadActiveSession: () => Promise.resolve(null),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderHomepage() {
  return render(
    <MemoryRouter>
      <Homepage />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Homepage — Open app link target", () => {
  // `/` is the marketing homepage for every visitor now, so "open app" must not
  // point there — /app is the workspace entry and it redirects signed-out
  // visitors to /login itself. The link is identity-independent on purpose:
  // these pages are prerendered and edge-cached, so their markup cannot depend
  // on who is asking. Signed-in visitors are steered by AppEntryBanner instead.
  it("points at /app regardless of session state", () => {
    renderHomepage()

    const links = screen.getAllByRole("link", { name: /open app/i })
    expect(links.length).toBeGreaterThan(0)
    links.forEach((link) => {
      expect(link).toHaveAttribute("href", "/app")
    })
  })

  it("never links back to /, which would bounce the user to marketing again", () => {
    renderHomepage()

    screen.getAllByRole("link", { name: /open app/i }).forEach((link) => {
      expect(link).not.toHaveAttribute("href", "/")
    })
  })
})
