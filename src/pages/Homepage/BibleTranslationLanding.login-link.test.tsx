/**
 * BibleTranslationLanding nav CTAs: Sign in → /login (or Docs when signed in),
 * Open app → /app.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { BibleTranslationLanding } from "./BibleTranslationLanding"

vi.mock("@/branding/use-brand", () => ({
  useBrand: () => ({
    app: { name: "Aquilla", tagline: "Tagline." },
    logo: { Mark: () => null },
    deploy: { domain: "aquilla.app" },
  }),
}))

vi.mock("./MultimodalWorkspaceBT", () => ({
  MultimodalWorkspace: () => null,
}))

vi.mock("./LanguageBlitzBT", () => ({
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

function renderLanding() {
  return render(
    <MemoryRouter>
      <BibleTranslationLanding />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockHasAuthHintCookie.mockReturnValue(false)
  mockLoadActiveSession.mockResolvedValue(null)
})

describe("BibleTranslationLanding — nav CTAs", () => {
  it("points Sign in at /login when signed out", () => {
    renderLanding()

    const links = screen.getAllByRole("link", { name: /^sign in$/i })
    expect(links.length).toBeGreaterThan(0)
    links.forEach((link) => {
      expect(link).toHaveAttribute("href", "/login")
    })
  })

  it("swaps Sign in for Docs when a session is present", async () => {
    mockLoadActiveSession.mockResolvedValue({ username: "dev" })
    renderLanding()

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

  it("points Open app at /app", () => {
    renderLanding()

    const links = screen.getAllByRole("link", { name: /open app/i })
    expect(links.length).toBeGreaterThan(0)
    links.forEach((link) => {
      expect(link).toHaveAttribute("href", "/app")
    })
  })

  it("uses Open app as the hero primary CTA", () => {
    renderLanding()

    const hero = document.querySelector(".aq-hero-actions")
    expect(hero).toBeTruthy()
    const primary = hero!.querySelector("a.aq-btn-gold")
    expect(primary).toHaveAttribute("href", "/app")
    expect(primary).toHaveTextContent(/open app/i)
  })

  it("never links Open app back to /, which would bounce the user to marketing again", () => {
    renderLanding()

    screen.getAllByRole("link", { name: /open app/i }).forEach((link) => {
      expect(link).not.toHaveAttribute("href", "/")
    })
  })
})
