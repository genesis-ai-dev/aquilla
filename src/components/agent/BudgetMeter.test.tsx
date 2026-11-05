/**
 * BudgetMeter tests — the normal meter shows a PERCENTAGE only (2026-08-31
 * review: raw "1 cr / 2,500 cr" reads as billing noise mid-conversation); the
 * exhausted state is visually and semantically distinct (role="alert") and
 * explains the run stopped at its cap, in org-facing CREDITS (never raw $).
 */

import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { BudgetMeter } from "./BudgetMeter"

describe("BudgetMeter", () => {
  it("shows percent-of-budget (no raw credit amounts) while under cap", () => {
    render(<BudgetMeter budget={{ spentCredits: 120, capCredits: 500, exhausted: false }} />)
    const status = screen.getByRole("status")
    expect(status).toHaveTextContent("24% of the run budget used")
    expect(status.textContent).not.toContain("cr")
  })

  it("floors tiny non-zero spend at <1% instead of a misleading 0%", () => {
    render(<BudgetMeter budget={{ spentCredits: 1, capCredits: 2500, exhausted: false }} />)
    expect(screen.getByRole("status")).toHaveTextContent("<1% of the run budget used")
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

  it("names the per-run limit as a per-run limit, never the workspace's credit cap (AQU-2313)", () => {
    // The ETT report: an Enterprise workspace (credits unlimited) was told a
    // run "stopped at its 2,500 cr credit cap" after spending 4 cr. The cap in
    // question is the ceiling on ONE run, which every plan has — so the
    // sentence must name that, and must not describe it as a credit cap.
    render(<BudgetMeter budget={{ spentCredits: 4, capCredits: 2500, exhausted: true, reason: "run_cost_cap" }} />)
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent("this run's own spending limit")
    expect(alert.textContent).not.toMatch(/credit cap/i)
    expect(alert).toHaveTextContent("2,500 cr")
    expect(alert).toHaveTextContent("4 cr")
    // The run is not a dead end — a follow-up question still works.
    expect(alert).toHaveTextContent("send a new message to continue")
    expect(alert.getAttribute("data-reason")).toBe("run_cost_cap")
  })

  it("reads an untagged exhausted frame as the per-run cap (pre-AQU-2313 server)", () => {
    render(<BudgetMeter budget={{ spentCredits: 500, capCredits: 500, exhausted: true }} />)
    const alert = screen.getByRole("alert")
    expect(alert.getAttribute("data-reason")).toBe("run_cost_cap")
    expect(alert.textContent).not.toMatch(/credit cap/i)
  })

  it("explains a weekly-allowance stop without credit figures and keeps the alert selector", () => {
    render(<BudgetMeter budget={{ spentCredits: 12, capCredits: 500, exhausted: true, reason: "weekly_allowance" }} />)
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent("weekly AI allowance")
    expect(alert).toHaveTextContent("already staged is kept")
    expect(alert.textContent).not.toMatch(/cr\b|\$/)
    expect(alert.getAttribute("data-frame-type")).toBe("budget.exhausted")
    expect(alert.getAttribute("data-reason")).toBe("weekly_allowance")
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
