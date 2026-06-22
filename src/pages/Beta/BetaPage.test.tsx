/**
 * The /beta page exists to communicate beta status and the Now/Next/Later
 * roadmap. These tests pin the things that page is *for*: the headline, all
 * three roadmap phases, and the two key CTAs (Discord feedback + Start free).
 */
import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { BetaPage } from "./BetaPage"

vi.mock("@/branding/use-brand", () => ({
  useBrand: () => ({
    app: { name: "Aquilla", tagline: "Tagline." },
    logo: { Mark: () => null },
    deploy: { domain: "aquilla.app" },
  }),
}))

// CSS import — no-op in tests.
vi.mock("../Homepage/homepage.css", () => ({}))

describe("BetaPage", () => {
  it("announces the public beta in the hero", () => {
    render(<BetaPage />)
    expect(screen.getByRole("heading", { level: 1, name: /public beta/i })).toBeTruthy()
  })

  it("renders all three roadmap phases", () => {
    render(<BetaPage />)
    for (const phase of ["Now", "Next", "Later"]) {
      expect(screen.getByText(phase, { selector: ".aq-road-phase" })).toBeTruthy()
    }
  })

  it("links to Discord for feedback and to onboarding to start free", () => {
    render(<BetaPage />)
    const discord = screen.getByRole("link", { name: /discord/i })
    expect(discord.getAttribute("href")).toContain("discord.gg")
    const start = screen.getAllByRole("link", { name: /start/i })
    expect(start.some((a) => a.getAttribute("href") === "/onboarding")).toBe(true)
  })
})
