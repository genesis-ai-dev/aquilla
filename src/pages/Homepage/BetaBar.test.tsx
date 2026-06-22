/**
 * The homepage beta strip must be reachable (links to /beta) and must stay
 * dismissed for the rest of the session once closed — otherwise it nags on
 * every scroll-to-top or re-render.
 */
import { describe, it, expect, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { BetaBar } from "./BetaBar"

beforeEach(() => {
  sessionStorage.clear()
})

describe("BetaBar", () => {
  it("renders a link to the /beta explainer page", () => {
    render(<BetaBar />)
    const link = screen.getByRole("link", { name: /public beta/i })
    expect(link).toHaveAttribute("href", "/beta")
  })

  it("hides for the session when dismissed", () => {
    render(<BetaBar />)
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }))
    expect(screen.queryByRole("link", { name: /public beta/i })).toBeNull()
    expect(sessionStorage.getItem("aq-betabar-dismissed")).toBe("1")
  })

  it("stays hidden on mount when already dismissed this session", () => {
    sessionStorage.setItem("aq-betabar-dismissed", "1")
    render(<BetaBar />)
    expect(screen.queryByRole("link", { name: /public beta/i })).toBeNull()
  })
})
