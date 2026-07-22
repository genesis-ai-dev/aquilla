/**
 * BudgetMeter tests — the normal meter shows spent/cap; the exhausted state
 * is visually and semantically distinct (role="alert") and explains the
 * run stopped at its cap. Values are org-facing CREDITS (never raw $) so the
 * agent surface matches the org credits panel.
 */

import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { BudgetMeter } from "./BudgetMeter"

describe("BudgetMeter", () => {
  it("shows spent / cap in credits as a status meter while under cap", () => {
    render(<BudgetMeter budget={{ spentCredits: 120, capCredits: 500, exhausted: false }} />)
    expect(screen.getByRole("status")).toHaveTextContent("120 cr / 500 cr")
  })

  it("never renders a raw $ amount", () => {
    render(<BudgetMeter budget={{ spentCredits: 120, capCredits: 500, exhausted: false }} />)
    expect(screen.getByRole("status").textContent).not.toContain("$")
  })

  it("switches to a distinct alert explaining the run stopped once exhausted", () => {
    render(<BudgetMeter budget={{ spentCredits: 500, capCredits: 500, exhausted: true }} />)
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent("Run stopped")
    expect(alert).toHaveTextContent("500 cr")
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("tags the meter data-frame-type by state for e2e selectors", () => {
    const { container: under } = render(
      <BudgetMeter budget={{ spentCredits: 120, capCredits: 500, exhausted: false }} />,
    )
    expect(under.querySelector('[data-frame-type="budget"]')).not.toBeNull()

    const { container: exhausted } = render(
      <BudgetMeter budget={{ spentCredits: 500, capCredits: 500, exhausted: true }} />,
    )
    expect(exhausted.querySelector('[data-frame-type="budget.exhausted"]')).not.toBeNull()
  })
})
