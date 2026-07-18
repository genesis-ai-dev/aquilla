/**
 * Tests for CreditsPanel — the org-overview credit cap usage panel.
 *
 * WHY these tests matter:
 *   The translator-never-sees-it invariant is a trust boundary, not a UX
 *   preference. Translators must NEVER see credit/cost signals — not when
 *   showToOrg is on, not when data is returned, not in any configuration.
 *   A regression here would expose cost data to rank-and-file team members.
 *
 *   Two independent gates protect this:
 *     1. Role gate (client): orgRoleLevel < MAINTAINER → no render, no fetch.
 *     2. Flag gate (server): backend 403 → null → no render.
 *   Both must hold. Tests for both are present below.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { CreditsPanel } from "./CreditsPanel"
import type { OrgCredits } from "@/lib/sync/credits"
import { ROLE } from "@/lib/frontier/roles"

vi.mock("@/lib/sync/credits", () => ({ getOrgCredits: vi.fn() }))
import { getOrgCredits } from "@/lib/sync/credits"
const mockGetOrgCredits = vi.mocked(getOrgCredits)

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

const SAMPLE_DATA: OrgCredits = {
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
  day: {
    totalCredits: 400,
    byRail: { llm: 200, agent: 150, tts: 50 },
    agentCredits: 150,
  },
  week: {
    totalCredits: 1800,
    byRail: { llm: 900, agent: 700, tts: 200 },
    agentCredits: 700,
  },
  remaining: {
    daily: 600,
    weekly: 3200,
    agentDaily: 450,
    agentWeekly: 2300,
  },
}

describe("CreditsPanel — renders for maintainer when data is present", () => {
  it("shows daily and weekly windows + the agent sub-cap for a maintainer", async () => {
    // WHY: this is the happy path — a maintainer should see the panel.
    mockGetOrgCredits.mockResolvedValue(SAMPLE_DATA)
    render(
      <CreditsPanel
        jwt="mgr-jwt"
        orgId={1}
        orgRoleLevel={ROLE.MAINTAINER}
        action={<span>Visibility control</span>}
      />,
    )

    await waitFor(() => expect(screen.getByTestId("credits-panel")).toBeInTheDocument())

    expect(screen.getByText("Compute credits")).toBeInTheDocument()
    expect(screen.getByTestId("credits-panel")).toHaveTextContent("Visibility control")
    // "Today"/"This week" label both the overall window and the agent sub-cap row.
    expect(screen.getAllByText("Today").length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText("This week").length).toBeGreaterThanOrEqual(1)
    // Overall + agent sub-cap totals are present via their stable test ids.
    expect(screen.getByTestId("cap-day-total")).toBeInTheDocument()
    expect(screen.getByTestId("cap-week-total")).toBeInTheDocument()
    expect(screen.getByTestId("agentcap-day")).toBeInTheDocument()
    expect(screen.getByTestId("agentcap-week")).toBeInTheDocument()
    // Agent sub-cap section headline.
    expect(screen.getByText(/Agent spend \(elevated rail/)).toBeInTheDocument()
    expect(mockGetOrgCredits).toHaveBeenCalledWith("mgr-jwt", 1)
  })

  it("surfaces the per-rail breakdown (chat, agent, TTS) the API returns", async () => {
    // WHY the follow-up UI work exists: chat spend was invisible before. The
    // legend must show each rail's own value, scoped per window.
    mockGetOrgCredits.mockResolvedValue(SAMPLE_DATA)
    render(<CreditsPanel jwt="mgr-jwt" orgId={1} orgRoleLevel={ROLE.MAINTAINER} />)
    await waitFor(() => expect(screen.getByTestId("credits-panel")).toBeInTheDocument())

    // Day byRail: { llm: 200, agent: 150, tts: 50 }
    expect(screen.getByTestId("rail-day-agent")).toHaveTextContent("150 cr")
    expect(screen.getByTestId("rail-day-llm")).toHaveTextContent("Chat")
    expect(screen.getByTestId("rail-day-llm")).toHaveTextContent("200 cr")
    expect(screen.getByTestId("rail-day-tts")).toHaveTextContent("50 cr")
    // Week byRail: { llm: 900, agent: 700, tts: 200 }
    expect(screen.getByTestId("rail-week-llm")).toHaveTextContent("900 cr")
  })

  it("shows the formatted daily total", async () => {
    mockGetOrgCredits.mockResolvedValue(SAMPLE_DATA)
    render(<CreditsPanel jwt="mgr-jwt" orgId={1} orgRoleLevel={ROLE.OWNER} />)
    await waitFor(() => expect(screen.getByTestId("credits-panel")).toBeInTheDocument())
    // Day total 400 cr against its 1,000 cr cap.
    expect(screen.getByTestId("cap-day-total")).toHaveTextContent("400 cr")
    expect(screen.getByTestId("cap-day-total")).toHaveTextContent("1,000 cr")
  })

  // NOTE: the "Caps are display-only — enforcement is off" notice was intentionally
  // removed in e92aacc49. The enforce=false state now renders no extra notice, so the
  // former "shows enforcement-off notice" test was dropped rather than weakened.
})

describe("CreditsPanel — AQU-414 regression: each bar binds to its own distinct bucket", () => {
  // WHY: AQU-414 was reported as "3 of 4 bars echo the same number" — a
  // transposed field mapping would make two bars silently render the same
  // value. Using four DISTINCT fixture numbers means any future swap of
  // day/week or total/agent fields fails loudly instead of coincidentally
  // passing (e.g. a swap between two bars that happen to share a value).
  const DISTINCT_DATA: OrgCredits = {
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
    day: {
      totalCredits: 11, // "Today"
      byRail: { llm: 0, agent: 33, tts: 0 },
      agentCredits: 33, // "Agent — today"
    },
    week: {
      totalCredits: 99, // "This week"
      byRail: { llm: 0, agent: 77, tts: 0 },
      agentCredits: 77, // "Agent — this week"
    },
    remaining: { daily: 989, weekly: 4901, agentDaily: 567, agentWeekly: 2923 },
  }

  it("binds each of the four buckets to its own test id, no transposition", async () => {
    mockGetOrgCredits.mockResolvedValue(DISTINCT_DATA)
    render(<CreditsPanel jwt="mgr-jwt" orgId={1} orgRoleLevel={ROLE.MAINTAINER} />)
    await waitFor(() => expect(screen.getByTestId("credits-panel")).toBeInTheDocument())

    // Each value pinned to its OWN element by test id — this is what catches a
    // transposition that a plain getByText can't. Day total (11) ≠ agent (33);
    // week total (99) ≠ agent (77); and none are swapped across windows.
    const dayTotal = screen.getByTestId("cap-day-total")
    expect(dayTotal).toHaveTextContent("11 cr")
    expect(dayTotal).not.toHaveTextContent("33 cr")
    expect(dayTotal).not.toHaveTextContent("99 cr")
    expect(dayTotal).not.toHaveTextContent("77 cr")

    const weekTotal = screen.getByTestId("cap-week-total")
    expect(weekTotal).toHaveTextContent("99 cr")
    expect(weekTotal).not.toHaveTextContent("11 cr")
    expect(weekTotal).not.toHaveTextContent("33 cr")
    expect(weekTotal).not.toHaveTextContent("77 cr")

    // Agent appears twice by design (rail legend + its own sub-cap); both must
    // carry the agent value for the matching window, never the total.
    expect(screen.getByTestId("rail-day-agent")).toHaveTextContent("33 cr")
    expect(screen.getByTestId("agentcap-day")).toHaveTextContent("33 cr")
    expect(screen.getByTestId("rail-week-agent")).toHaveTextContent("77 cr")
    expect(screen.getByTestId("agentcap-week")).toHaveTextContent("77 cr")

    expect(screen.getByTestId("rail-day-agent")).not.toHaveTextContent("11 cr")
    expect(screen.getByTestId("rail-week-agent")).not.toHaveTextContent("99 cr")
  })
})

describe("CreditsPanel — translator-never-sees-it invariant", () => {
  it("renders nothing for a translator (role < MAINTAINER)", async () => {
    // WHY: THIS IS THE TRUST BOUNDARY. Translators have role levels below 600.
    // They must never see credit/cost signals. If this test fails, cost data
    // is leaking to rank-and-file team members.
    mockGetOrgCredits.mockResolvedValue(SAMPLE_DATA)
    const { container } = render(
      <CreditsPanel jwt="member-jwt" orgId={1} orgRoleLevel={ROLE.CONTRIBUTOR} />,
    )
    // Give the component time to settle (it must not fetch at all for < MAINTAINER)
    await new Promise((r) => setTimeout(r, 0))
    expect(container).toBeEmptyDOMElement()
    // Also verify the fetch was skipped entirely — the role gate must prevent
    // the fetch, not just hide the rendered output.
    expect(mockGetOrgCredits).not.toHaveBeenCalled()
  })

  it("renders nothing for viewer role (100)", async () => {
    // WHY: lowest role — belt-and-suspenders check that every sub-maintainer role is blocked.
    const { container } = render(
      <CreditsPanel jwt="viewer-jwt" orgId={1} orgRoleLevel={ROLE.VIEWER} />,
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(container).toBeEmptyDOMElement()
    expect(mockGetOrgCredits).not.toHaveBeenCalled()
  })

  it("renders nothing for project_lead role (500) — just below MAINTAINER", async () => {
    // WHY: 500 is the boundary case — one below MAINTAINER (600). Must be blocked.
    const { container } = render(
      <CreditsPanel jwt="lead-jwt" orgId={1} orgRoleLevel={ROLE.PROJECT_LEAD} />,
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(container).toBeEmptyDOMElement()
    expect(mockGetOrgCredits).not.toHaveBeenCalled()
  })
})

describe("CreditsPanel — hides on null/403", () => {
  it("renders nothing when getOrgCredits returns null (server 403 / showToOrg=off)", async () => {
    // WHY: the flag gate — server returns 403 when showToOrg is off. This is the
    // server-enforced part of the trust boundary. UI must self-hide on null.
    mockGetOrgCredits.mockResolvedValue(null)
    const { container } = render(
      <CreditsPanel
        jwt="mgr-jwt"
        orgId={1}
        orgRoleLevel={ROLE.MAINTAINER}
        action={<span>Visibility control</span>}
      />,
    )
    await waitFor(() => expect(mockGetOrgCredits).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByTestId("credits-panel")).not.toBeInTheDocument()
    expect(screen.queryByText("Visibility control")).not.toBeInTheDocument()
  })

  it("renders nothing on transient fetch error", async () => {
    // WHY: CreditsPanel is additive — a transient failure must not break the org Overview.
    mockGetOrgCredits.mockRejectedValue(new Error("network error"))
    const { container } = render(
      <CreditsPanel jwt="mgr-jwt" orgId={1} orgRoleLevel={ROLE.MAINTAINER} />,
    )
    await waitFor(() => expect(mockGetOrgCredits).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })
})
