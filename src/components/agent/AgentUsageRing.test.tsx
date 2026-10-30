/**
 * AgentUsageRing tests — the composer usage gauge that replaced the
 * per-message usage line.
 *
 * WHY these tests matter:
 *   Every project member sees the composer. AQU-2068 made the gauge the org's
 *   one % meter for everyone (no credit figures for anyone, spec R7). When the
 *   meter cannot load, the latest run's budget % is the only usage readout
 *   left, so it must still appear once a run reports a budget.
 */

import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type { AgentRunUi } from "@/lib/agent/run-state"
import type { MeterView } from "@/lib/billing/ai-meter"
import { renderWithTooltips, expectClickNote } from "@/test-utils/tooltip"
import { AgentUsageRing } from "./AgentUsageRing"

function run(id: string, budget?: AgentRunUi["budget"]): AgentRunUi {
  return { localId: id, prompt: "p", runId: null, items: [], status: "ok", budget }
}
const meter = (view: MeterView) => ({ view, orgId: 1, canManage: false, agent: true })

describe("AgentUsageRing", () => {
  it("shows the org's % meter instead of the run ring once it loads", () => {
    render(
      <MemoryRouter>
        <AgentUsageRing
          meter={meter({ kind: "metered", tier: "free", percent: 42, level: "ok", resetsAt: null })}
          runs={[run("a", { spentCredits: 120, capCredits: 500, exhausted: false })]}
        />
      </MemoryRouter>,
    )
    const ring = screen.getByTestId("ai-meter-compact")
    expect(ring).toHaveAccessibleName("42% of this week's AI used")
    expect(screen.queryByTestId("run-budget-ring")).toBeNull()
    expect(document.body.textContent).not.toMatch(/credit|\$/i)
  })

  it("falls back to the run-budget % while the meter is unavailable", () => {
    // A blank slot would leave the member no usage readout at all.
    render(
      <AgentUsageRing
        meter={meter({ kind: "unavailable" })}
        runs={[run("a", { spentCredits: 400, capCredits: 500, exhausted: false }), run("b", { spentCredits: 120, capCredits: 500, exhausted: false })]}
      />,
    )
    const ring = screen.getByTestId("run-budget-ring")
    expect(ring).toHaveAccessibleName("24% of the run budget used")
    expect(ring.getAttribute("aria-label")).not.toMatch(/cr\b|\$/)
  })

  // AQU-2260 (Sam, Oct 29): the ring is a reading, not a button, so it may not
  // explain itself on hover. Its figure opens on click.
  it("opens the run-budget reading on click, never on hover", async () => {
    renderWithTooltips(
      <AgentUsageRing
        meter={meter({ kind: "unavailable" })}
        runs={[run("a", { spentCredits: 120, capCredits: 500, exhausted: false })]}
      />,
    )
    await expectClickNote(screen.getByTestId("run-budget-ring"), "24% of the run budget used")
  })

  it("renders nothing before the meter loads or any run reports a budget", () => {
    const { container } = render(<AgentUsageRing meter={meter({ kind: "loading" })} runs={[run("a")]} />)
    expect(container.innerHTML).toBe("")
  })
})
