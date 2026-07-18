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

const mockHasAuthHintCookie = vi.fn()
vi.mock("@/lib/frontier/session-store", () => ({
  hasAuthHintCookie: () => mockHasAuthHintCookie(),
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

describe("Homepage — Open app link target (AQU-282)", () => {
  it("points to /login when the user is not signed in", () => {
    mockHasAuthHintCookie.mockReturnValue(false)
    renderHomepage()

    const links = screen.getAllByRole("link", { name: /open app/i })
    expect(links.length).toBeGreaterThan(0)
    links.forEach((link) => {
      expect(link).toHaveAttribute("href", "/login")
    })
  })

  it("points to / when the auth-hint cookie is set (signed-in user)", () => {
    mockHasAuthHintCookie.mockReturnValue(true)
    renderHomepage()

    const links = screen.getAllByRole("link", { name: /open app/i })
    expect(links.length).toBeGreaterThan(0)
    links.forEach((link) => {
      expect(link).toHaveAttribute("href", "/")
    })
  })
})
