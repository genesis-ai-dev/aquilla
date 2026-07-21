/**
 * BudgetMeter tests — the normal meter shows spent/cap; the exhausted state
 * is visually and semantically distinct (role="alert") and explains the
 * run stopped at its cap.
 */

import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { BudgetMeter } from "./BudgetMeter"

describe("BudgetMeter", () => {
  it("shows spent / cap as a status meter while under cap", () => {
    render(<BudgetMeter budget={{ spentCents: 120, capCents: 500, exhausted: false }} />)
    expect(screen.getByRole("status")).toHaveTextContent("$1.20 / $5.00")
  })

  it("switches to a distinct alert explaining the run stopped once exhausted", () => {
    render(<BudgetMeter budget={{ spentCents: 500, capCents: 500, exhausted: true }} />)
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent("Run stopped")
    expect(alert).toHaveTextContent("$5.00")
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("tags the meter data-frame-type by state for e2e selectors", () => {
    const { container: under } = render(
      <BudgetMeter budget={{ spentCents: 120, capCents: 500, exhausted: false }} />,
    )
    expect(under.querySelector('[data-frame-type="budget"]')).not.toBeNull()

    const { container: exhausted } = render(
      <BudgetMeter budget={{ spentCents: 500, capCents: 500, exhausted: true }} />,
    )
    expect(exhausted.querySelector('[data-frame-type="budget.exhausted"]')).not.toBeNull()
  })
})
