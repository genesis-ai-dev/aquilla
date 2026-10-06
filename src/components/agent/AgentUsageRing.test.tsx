/**
 * AgentUsageRing tests — the composer usage gauge that replaced the
 * per-message usage line.
 *
 * WHY these tests matter:
 *   Every project member sees the composer, so the role split is the point:
 *   maintainers get org credit figures (CreditsDial), translators get only a
 *   percentage of the run budget and must never see credits or fetch org
 *   spend. And with the per-reply line gone, the ring is the only usage
 *   readout — it must actually appear once a run reports a budget.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import type { AgentRunUi } from "@/lib/agent/run-state"
import type { OrgCredits } from "@/lib/sync/credits"
import { ROLE } from "@/lib/frontier/roles"
import { AgentUsageRing } from "./AgentUsageRing"

vi.mock("@/lib/sync/credits", () => ({ getOrgCredits: vi.fn() }))
import { getOrgCredits } from "@/lib/sync/credits"
const mockGetOrgCredits = vi.mocked(getOrgCredits)

beforeEach(() => vi.clearAllMocks())

const ORG_CREDITS: OrgCredits = {
  config: {
    markup: 4,
    agentMarkup: 5,
    dailyCap: 1000,
    weeklyCap: 5000,
    agentDailyCap: 600,
    agentWeeklyCap: 3000,
    enforce: true,
    showToOrg: true,
  },
  day: { totalCredits: 400, byRail: { llm: 200, agent: 150, tts: 50 }, agentCredits: 150 },
  week: { totalCredits: 1800, byRail: { llm: 900, agent: 700, tts: 200 }, agentCredits: 700 },
  remaining: { daily: 600, weekly: 3200, agentDaily: 450, agentWeekly: 2300 },
}

function run(id: string, budget?: AgentRunUi["budget"]): AgentRunUi {
  return { localId: id, prompt: "p", runId: null, items: [], status: "ok", budget }
}

const credits = (orgRoleLevel: number) => ({ jwt: "jwt", orgId: 1, orgRoleLevel })

describe("AgentUsageRing", () => {
  it("shows a translator the latest run's budget as a percentage, never credits", () => {
    mockGetOrgCredits.mockResolvedValue(ORG_CREDITS)
    render(
      <AgentUsageRing
        credits={credits(ROLE.MAINTAINER - 1)}
        runs={[run("a", { spentCredits: 400, capCredits: 500, exhausted: false }), run("b", { spentCredits: 120, capCredits: 500, exhausted: false })]}
        isStreaming={false}
      />,
    )
    const ring = screen.getByTestId("run-budget-ring")
    expect(ring).toHaveAccessibleName("24% of the run budget used")
    expect(ring.getAttribute("aria-label")).not.toMatch(/cr\b|\$/)
    expect(screen.queryByTestId("credits-dial")).toBeNull()
    expect(mockGetOrgCredits).not.toHaveBeenCalled()
  })

  it("renders nothing for a translator before any run reports a budget", () => {
    const { container } = render(
      <AgentUsageRing credits={credits(ROLE.MAINTAINER - 1)} runs={[run("a")]} isStreaming={false} />,
    )
    expect(container.innerHTML).toBe("")
  })

  it("gives a maintainer the org credit dial instead of the run ring", async () => {
    mockGetOrgCredits.mockResolvedValue(ORG_CREDITS)
    render(
      <AgentUsageRing
        credits={credits(ROLE.MAINTAINER)}
        runs={[run("a", { spentCredits: 120, capCredits: 500, exhausted: false })]}
        isStreaming={false}
      />,
    )
    expect(await screen.findByTestId("credits-dial")).toBeInTheDocument()
    expect(screen.queryByTestId("run-budget-ring")).toBeNull()
  })

  it("re-fetches org spend when a run settles, so the dial isn't stale", async () => {
    mockGetOrgCredits.mockResolvedValue(ORG_CREDITS)
    const view = render(<AgentUsageRing credits={credits(ROLE.MAINTAINER)} runs={[]} isStreaming={false} />)
    await waitFor(() => expect(mockGetOrgCredits).toHaveBeenCalledTimes(1))
    view.rerender(<AgentUsageRing credits={credits(ROLE.MAINTAINER)} runs={[run("a")]} isStreaming />)
    view.rerender(<AgentUsageRing credits={credits(ROLE.MAINTAINER)} runs={[run("a")]} isStreaming={false} />)
    await waitFor(() => expect(mockGetOrgCredits).toHaveBeenCalledTimes(3))
  })
})
