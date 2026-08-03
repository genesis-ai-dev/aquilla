import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import {
  BlockingLoadingOverlay,
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

describe("BlockingLoadingOverlay (AQU-737)", () => {
  // WHY: while a route transition is in flight, the whole display area must be
  // covered so no other control can be activated — unlike LoadingTemplate's
  // scrim, which is pointer-transparent because its template is already inert.
  it("portals a viewport-covering, input-swallowing busy status to <body>", () => {
    const { container } = render(
      <div>
        <BlockingLoadingOverlay label="Opening project" />
      </div>,
    )

    const status = screen.getByRole("status", { name: "Opening project" })
    expect(status).toHaveAttribute("aria-busy", "true")
    // Portaled out of the render tree so no ancestor stacking context or
    // overflow clip can trap it below other controls.
    expect(container.contains(status)).toBe(false)
    expect(status.parentElement).toBe(document.body)
    // Fixed full-viewport layer with NO pointer-events-none: the layer itself
    // must swallow clicks aimed at controls beneath it.
    expect(status).toHaveClass("fixed", "inset-0")
    expect(status.className).not.toContain("pointer-events-none")
  })

  it("shows the shared spinner pill with the label", () => {
    render(<BlockingLoadingOverlay label="Opening project" />)

    const status = screen.getByRole("status", { name: "Opening project" })
    const spinner = status.querySelector("[data-slot='spinner']")
    expect(spinner).not.toBeNull()
    expect(spinner).toHaveClass("animate-spin")
    expect(screen.getByText("Opening project…")).toBeInTheDocument()
  })
})
