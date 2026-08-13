/**
 * Pricing cards stretch to a shared height; the CTA lives in a flex-1
 * justify-end wrapper so buttons line up at the bottom of each card
 * regardless of copy length.
 */
import { describe, it, expect, vi } from "vitest"
import { render } from "@testing-library/react"
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

describe("Homepage — pricing CTAs", () => {
  it("wraps each card's button in a bottom-aligned CTA slot", () => {
    render(
      <MemoryRouter>
        <Homepage />
      </MemoryRouter>,
    )

    const cards = document.querySelectorAll("#pricing .aq-price")
    expect(cards.length).toBe(3)
    cards.forEach((card) => {
      const cta = card.querySelector(":scope > .aq-price-cta")
      expect(cta).toBeTruthy()
      expect(cta!.querySelector(":scope > .aq-btn")).toBeTruthy()
    })
  })
})
