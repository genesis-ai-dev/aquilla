import { describe, it, expect, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { RightSidebarPanel } from "./RightSidebarPanel"

describe("RightSidebarPanel", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("renders children at the default width and exposes a resize handle", () => {
    const { container } = render(
      <RightSidebarPanel storageKey="test-panel" defaultWidth={320} resizeLabel="Resize test panel">
        <div data-testid="panel-body">body</div>
      </RightSidebarPanel>,
    )

    expect(screen.getByTestId("panel-body")).toBeInTheDocument()
    const shell = container.querySelector('[data-slot="right-sidebar-panel"]')
    expect(shell).toHaveStyle({ width: "320px" })
    expect(screen.getByRole("separator", { name: /resize test panel/i })).toBeInTheDocument()
  })

  it("restores a previously stored width", () => {
    localStorage.setItem("right-sidebar-width:test-panel", "480")
    const { container } = render(
      <RightSidebarPanel storageKey="test-panel" defaultWidth={320}>
        <div>body</div>
      </RightSidebarPanel>,
    )
    expect(container.querySelector('[data-slot="right-sidebar-panel"]')).toHaveStyle({
      width: "480px",
    })
  })

  it("widens on ArrowLeft and persists", () => {
    render(
      <RightSidebarPanel storageKey="test-panel" defaultWidth={320} minWidth={240} maxWidth={640}>
        <div>body</div>
      </RightSidebarPanel>,
    )
    const handle = screen.getByRole("separator", { name: /resize panel/i })
    fireEvent.keyDown(handle, { key: "ArrowLeft" })
    expect(handle).toHaveAttribute("aria-valuenow", "328")
    expect(localStorage.getItem("right-sidebar-width:test-panel")).toBe("328")
  })
})
