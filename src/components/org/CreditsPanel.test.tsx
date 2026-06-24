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
  it("shows daily and weekly cap bars for a maintainer", async () => {
    // WHY: this is the happy path — a maintainer should see the panel.
    mockGetOrgCredits.mockResolvedValue(SAMPLE_DATA)
    render(<CreditsPanel jwt="mgr-jwt" orgId={1} orgRoleLevel={ROLE.MAINTAINER} />)

    await waitFor(() => expect(screen.getByTestId("credits-panel")).toBeInTheDocument())

    expect(screen.getByText("Compute credits")).toBeInTheDocument()
    expect(screen.getByText("Today")).toBeInTheDocument()
    expect(screen.getByText("This week")).toBeInTheDocument()
    // Agent section headline
    expect(screen.getByText("Agent spend (elevated rail)")).toBeInTheDocument()
    // Agent sub-bars
    expect(screen.getByText("Agent today")).toBeInTheDocument()
    expect(screen.getByText("Agent this week")).toBeInTheDocument()
    expect(mockGetOrgCredits).toHaveBeenCalledWith("mgr-jwt", 1)
  })

  it("shows formatted credit values", async () => {
    mockGetOrgCredits.mockResolvedValue(SAMPLE_DATA)
    render(<CreditsPanel jwt="mgr-jwt" orgId={1} orgRoleLevel={ROLE.OWNER} />)
    await waitFor(() => expect(screen.getByTestId("credits-panel")).toBeInTheDocument())
    // Day cap: 400 cr / 1,000 cr
    expect(screen.getByText("400 cr")).toBeInTheDocument()
  })

  // NOTE: the "Caps are display-only — enforcement is off" notice was intentionally
  // removed in e92aacc49. The enforce=false state now renders no extra notice, so the
  // former "shows enforcement-off notice" test was dropped rather than weakened.
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
      <CreditsPanel jwt="mgr-jwt" orgId={1} orgRoleLevel={ROLE.MAINTAINER} />,
    )
    await waitFor(() => expect(mockGetOrgCredits).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByTestId("credits-panel")).not.toBeInTheDocument()
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
