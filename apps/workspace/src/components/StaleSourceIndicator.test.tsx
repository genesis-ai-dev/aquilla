import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { StaleSourceIndicator } from "./StaleSourceIndicator"

describe("StaleSourceIndicator (managed mode)", () => {
  it("renders the badge when the cell is in the stale set", () => {
    render(
      <StaleSourceIndicator
        cellId="c1"
        staleCellIds={new Set(["c1", "c3"])}
      />,
    )
    expect(screen.getByTestId("stale-source-indicator")).toBeInTheDocument()
  })

  it("renders nothing when the cell is not stale", () => {
    const { container } = render(
      <StaleSourceIndicator
        cellId="c2"
        staleCellIds={new Set(["c1"])}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("renders nothing with an empty set", () => {
    const { container } = render(
      <StaleSourceIndicator cellId="c1" staleCellIds={new Set()} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("uses a custom tooltip text when provided", () => {
    render(
      <StaleSourceIndicator
        cellId="c1"
        staleCellIds={new Set(["c1"])}
        tooltipText="custom message"
      />,
    )
    const el = screen.getByRole("img")
    expect(el).toHaveAttribute("aria-label", "Source changed since last revision")
  })
})
