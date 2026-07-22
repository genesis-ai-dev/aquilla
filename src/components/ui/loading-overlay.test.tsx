import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { LoadingOverlay } from "@/components/ui/loading-overlay"

describe("LoadingOverlay", () => {
  // AQU-637: the route/chunk-transition loading state must be an accessible,
  // animated overlay — not bland "Loading…" text — so the wait reads clearly
  // and is discoverable in the accessibility tree.
  it("exposes an accessible, busy loading status", () => {
    render(<LoadingOverlay />)

    const status = screen.getByRole("status", { name: "Loading" })
    expect(status).toHaveAttribute("aria-busy", "true")
  })

  it("renders the shared animated spinner (visible motion)", () => {
    const { container } = render(<LoadingOverlay />)

    // Reuses the <Spinner> primitive (lucide Loader2, animate-spin) rather
    // than reinventing spinner styling.
    const spinner = container.querySelector("[data-slot='spinner']")
    expect(spinner).not.toBeNull()
    expect(spinner).toHaveClass("animate-spin")
  })

  it("supports a custom label", () => {
    render(<LoadingOverlay label="Opening project" />)

    expect(
      screen.getByRole("status", { name: "Opening project" }),
    ).toBeInTheDocument()
  })
})
