/**
 * Homepage nav CTAs: Sign in → /login (or Docs when signed in), Open app → /app
 *
 * Marketing pages are prerendered and edge-cached, so the initial markup is
 * always the signed-out variant. After mount, a stored session swaps Sign in
 * for Docs. /app redirects signed-out visitors to /login; /login redirects
 * already-signed-in visitors into the workspace.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
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

vi.mock("./homepage.css", () => ({}))

const mockHasAuthHintCookie = vi.fn(() => false)
const mockLoadActiveSession = vi.fn(() => Promise.resolve(null))
vi.mock("@/lib/frontier/session-store", () => ({
  hasAuthHintCookie: () => mockHasAuthHintCookie(),
  loadActiveSession: () => mockLoadActiveSession(),
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
  mockHasAuthHintCookie.mockReturnValue(false)
  mockLoadActiveSession.mockResolvedValue(null)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Homepage — nav CTAs", () => {
  it("points Sign in at /login when signed out", () => {
    renderHomepage()

    const links = screen.getAllByRole("link", { name: /^sign in$/i })
    expect(links.length).toBeGreaterThan(0)
    links.forEach((link) => {
      expect(link).toHaveAttribute("href", "/login")
    })
  })

  it("swaps Sign in for Docs when a session is present", async () => {
    mockLoadActiveSession.mockResolvedValue({ username: "dev" })
    renderHomepage()

    await waitFor(() => {
      const docsCtas = screen
        .getAllByRole("link", { name: /^docs$/i })
        .filter((link) => link.className.includes("aq-btn"))
      expect(docsCtas.length).toBeGreaterThan(0)
      docsCtas.forEach((link) => {
        expect(link).toHaveAttribute("href", "https://help.aquilla.app")
      })
    })
    expect(screen.queryByRole("link", { name: /^sign in$/i })).not.toBeInTheDocument()
  })

  it("swaps Sign in for Docs when the auth-hint cookie is present", async () => {
    mockHasAuthHintCookie.mockReturnValue(true)
    renderHomepage()

    await waitFor(() => {
      expect(
        screen.getAllByRole("link", { name: /^docs$/i }).some((link) =>
          link.className.includes("aq-btn"),
        ),
      ).toBe(true)
    })
    expect(screen.queryByRole("link", { name: /^sign in$/i })).not.toBeInTheDocument()
  })

  it("points Open app at /app", () => {
    renderHomepage()

    const links = screen.getAllByRole("link", { name: /open app/i })
    expect(links.length).toBeGreaterThan(0)
    links.forEach((link) => {
      expect(link).toHaveAttribute("href", "/app")
    })
  })

  it("uses Open app as the hero primary CTA", () => {
    renderHomepage()

    const hero = document.querySelector(".aq-hero-actions")
    expect(hero).toBeTruthy()
    const primary = hero!.querySelector("a.aq-btn-gold")
    expect(primary).toHaveAttribute("href", "/app")
    expect(primary).toHaveTextContent(/open app/i)
  })

  it("never links Open app back to /, which would bounce the user to marketing again", () => {
    renderHomepage()

    screen.getAllByRole("link", { name: /open app/i }).forEach((link) => {
      expect(link).not.toHaveAttribute("href", "/")
    })
  })
})
