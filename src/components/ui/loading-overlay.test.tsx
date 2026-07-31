import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import {
  LoadingOverlay,
  LoadingPanel,
  LoadingTemplate,
} from "@/components/ui/loading-overlay"

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

    // Reuses the shared <Spinner> primitive (SVG ring + animate-spin) rather
    // than reinventing spinner styling.
    const spinner = container.querySelector("[data-slot='spinner']")
    expect(spinner).not.toBeNull()
    expect(spinner).toHaveClass("animate-spin")
    expect(spinner).toHaveClass("motion-reduce:animate-none")
    expect(screen.getByTestId("loading-neutral-template")).toBeInTheDocument()
  })

  it("supports a custom label", () => {
    render(<LoadingOverlay label="Opening project" />)

    expect(
      screen.getByRole("status", { name: "Opening project" }),
    ).toBeInTheDocument()
  })

  it("uses a supplied destination template instead of the neutral fallback", () => {
    render(
      <LoadingOverlay>
        <div data-testid="custom-loading-template" />
      </LoadingOverlay>,
    )

    expect(screen.getByTestId("custom-loading-template")).toBeInTheDocument()
    expect(screen.queryByTestId("loading-neutral-template")).not.toBeInTheDocument()
    expect(screen.getByTestId("custom-loading-template").parentElement).toHaveAttribute("inert")
  })

  it("supports container-sized destination templates", () => {
    render(
      <LoadingTemplate label="Loading project details" className="min-h-64">
        <div data-testid="project-details-template" />
      </LoadingTemplate>,
    )

    expect(
      screen.getByRole("status", { name: "Loading project details" }),
    ).toHaveClass("min-h-64")
    expect(screen.getByTestId("project-details-template").parentElement).toHaveAttribute("inert")
    expect(screen.getByText("Loading project details…")).toBeInTheDocument()
  })

  it("provides a value-free fallback for major panels", () => {
    render(<LoadingPanel label="Loading terminology" />)

    expect(
      screen.getByRole("status", { name: "Loading terminology" }),
    ).toBeInTheDocument()
    expect(screen.getByTestId("loading-panel-template")).toBeInTheDocument()
    expect(screen.getByText("Loading terminology…")).toBeInTheDocument()
  })
})
