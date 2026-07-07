/**
 * Tests for AdminCreditsSection — platform-admin compute/credits table.
 *
 * WHY these tests matter:
 *   - The admin table must render per-org credit spend.
 *   - Agent spend must be visually distinguished (the dangerous rail).
 *   - enforce and showToOrg toggles must call setOrgCreditConfig with the
 *     right patch — a broken toggle silently disables enforcement or leaks
 *     cost data to org maintainers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { AdminCreditsSection } from "./AdminCreditsSection"
import type { AdminOrgCredits } from "@/lib/sync/credits"

vi.mock("@/lib/sync/credits", () => ({
  listOrgCredits: vi.fn(),
  setOrgCreditConfig: vi.fn(),
}))
import { listOrgCredits, setOrgCreditConfig } from "@/lib/sync/credits"
const mockList = vi.mocked(listOrgCredits)
const mockPatch = vi.mocked(setOrgCreditConfig)

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

const ORG_A: AdminOrgCredits = {
  orgId: 1,
  orgName: "Bible Translators",
  day: {
    totalCredits: 300,
    byRail: { llm: 100, agent: 180, tts: 20 },
    agentCredits: 180,
  },
  week: {
    totalCredits: 1400,
    byRail: { llm: 500, agent: 800, tts: 100 },
    agentCredits: 800,
  },
  config: {
    markup: 4,
    agentMarkup: 5,
    dailyCap: 1000,
    weeklyCap: 5000,
    agentDailyCap: 600,
    agentWeeklyCap: 3000,
    enforce: false,
    showToOrg: false,
  },
}

const ORG_B: AdminOrgCredits = {
  orgId: 2,
  orgName: "Grace Bible Church",
  day: {
    totalCredits: 0,
    byRail: { llm: 0, agent: 0, tts: 0 },
    agentCredits: 0,
  },
  week: {
    totalCredits: 0,
    byRail: { llm: 0, agent: 0, tts: 0 },
    agentCredits: 0,
  },
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
}

describe("AdminCreditsSection — table render", () => {
  it("renders org rows with credit spend", async () => {
    // WHY: platform admin must see all orgs' spend at a glance.
    mockList.mockResolvedValue([ORG_A, ORG_B])
    render(<AdminCreditsSection jwt="admin-jwt" />)

    await waitFor(() => expect(screen.getByTestId("admin-credits-table")).toBeInTheDocument())

    expect(screen.getByText("Bible Translators")).toBeInTheDocument()
    expect(screen.getByText("Grace Bible Church")).toBeInTheDocument()
    expect(mockList).toHaveBeenCalledWith("admin-jwt")
  })

  it("shows formatted credit values in the table", async () => {
    mockList.mockResolvedValue([ORG_A])
    render(<AdminCreditsSection jwt="admin-jwt" />)
    await waitFor(() => expect(screen.getByTestId("admin-credits-table")).toBeInTheDocument())
    // Day total: 300 cr
    expect(screen.getByText("300 cr")).toBeInTheDocument()
  })
})

describe("AdminCreditsSection — agent spend is visually highlighted", () => {
  it("marks agent-day cell with the agent highlight test id", async () => {
    // WHY: agent is the dangerous rail. A failure to highlight it means the
    // platform admin might not notice a runaway agent session burning budget.
    mockList.mockResolvedValue([ORG_A])
    render(<AdminCreditsSection jwt="admin-jwt" />)
    await waitFor(() => expect(screen.getByTestId("admin-credits-table")).toBeInTheDocument())

    // The agent-day cell must be present and contain the agent spend value
    const agentDayCell = screen.getByTestId("agent-day-1")
    expect(agentDayCell).toBeInTheDocument()
    expect(agentDayCell).toHaveTextContent("180 cr")

    const agentWeekCell = screen.getByTestId("agent-week-1")
    expect(agentWeekCell).toBeInTheDocument()
    expect(agentWeekCell).toHaveTextContent("800 cr")
  })
})

describe("AdminCreditsSection — FRO-414 regression: each column binds to its own distinct bucket", () => {
  // WHY: FRO-414 was reported as Day-spend / Agent(day) / Week-spend / Agent(wk)
  // showing duplicated values. Four distinct fixture numbers make a future
  // transposition between these columns fail loudly rather than passing by
  // coincidence (as it could if two of the four happened to share a value).
  const ORG_DISTINCT: AdminOrgCredits = {
    orgId: 3,
    orgName: "Distinct Org",
    day: {
      totalCredits: 11, // Day spend
      byRail: { llm: 0, agent: 33, tts: 0 },
      agentCredits: 33, // Agent (day)
    },
    week: {
      totalCredits: 99, // Week spend
      byRail: { llm: 0, agent: 77, tts: 0 },
      agentCredits: 77, // Agent (wk)
    },
    config: {
      markup: 4,
      agentMarkup: 5,
      dailyCap: 1000,
      weeklyCap: 5000,
      agentDailyCap: 600,
      agentWeeklyCap: 3000,
      enforce: false,
      showToOrg: false,
    },
  }

  it("binds each of the four spend buckets to its own test id, no transposition", async () => {
    mockList.mockResolvedValue([ORG_DISTINCT])
    render(<AdminCreditsSection jwt="admin-jwt" />)
    await waitFor(() => expect(screen.getByTestId("admin-credits-table")).toBeInTheDocument())

    // Window totals and agent sub-values each pinned to their own test id, so a
    // transposition between total↔agent or day↔week fails loudly.
    const dayTotal = screen.getByTestId("cap-day-3")
    expect(dayTotal).toHaveTextContent("11 cr")
    expect(dayTotal).not.toHaveTextContent("33 cr")
    expect(dayTotal).not.toHaveTextContent("99 cr")
    expect(dayTotal).not.toHaveTextContent("77 cr")

    const weekTotal = screen.getByTestId("cap-week-3")
    expect(weekTotal).toHaveTextContent("99 cr")
    expect(weekTotal).not.toHaveTextContent("11 cr")
    expect(weekTotal).not.toHaveTextContent("33 cr")
    expect(weekTotal).not.toHaveTextContent("77 cr")

    // Agent (day/week) via the dedicated agent-rail test ids.
    expect(screen.getByTestId("agent-day-3")).toHaveTextContent("33 cr")
    expect(screen.getByTestId("agent-day-3")).not.toHaveTextContent("11 cr")
    expect(screen.getByTestId("agent-week-3")).toHaveTextContent("77 cr")
    expect(screen.getByTestId("agent-week-3")).not.toHaveTextContent("99 cr")
  })
})

describe("AdminCreditsSection — enforce toggle", () => {
  it("calls setOrgCreditConfig with { enforce: true } when toggled on", async () => {
    // WHY: enforce toggle transitions from log-only to hard-blocking. A broken
    // toggle silently leaves budgets unenforced despite the admin flipping the switch.
    mockList.mockResolvedValue([ORG_A]) // enforce: false
    mockPatch.mockResolvedValue(undefined)
    mockList.mockResolvedValueOnce([ORG_A]).mockResolvedValue([{ ...ORG_A, config: { ...ORG_A.config, enforce: true } }])

    render(<AdminCreditsSection jwt="admin-jwt" />)
    await waitFor(() => expect(screen.getByTestId("admin-credits-table")).toBeInTheDocument())

    const enforceToggle = screen.getByTestId("enforce-toggle-1")
    expect(enforceToggle).toHaveAttribute("aria-checked", "false")

    fireEvent.click(enforceToggle)

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith("admin-jwt", 1, { enforce: true }))
  })
})

describe("AdminCreditsSection — showToOrg toggle", () => {
  it("calls setOrgCreditConfig with { showToOrg: true } when toggled on", async () => {
    // WHY: showToOrg exposes credits data to org maintainers. The toggle must
    // call the correct patch key — a wrong key silently prevents the reveal.
    mockList.mockResolvedValue([ORG_A]) // showToOrg: false
    mockPatch.mockResolvedValue(undefined)
    mockList.mockResolvedValueOnce([ORG_A]).mockResolvedValue([{ ...ORG_A, config: { ...ORG_A.config, showToOrg: true } }])

    render(<AdminCreditsSection jwt="admin-jwt" />)
    await waitFor(() => expect(screen.getByTestId("admin-credits-table")).toBeInTheDocument())

    const showOrgToggle = screen.getByTestId("show-org-toggle-1")
    expect(showOrgToggle).toHaveAttribute("aria-checked", "false")

    fireEvent.click(showOrgToggle)

    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith("admin-jwt", 1, { showToOrg: true }),
    )
  })

  it("calls setOrgCreditConfig with { showToOrg: false } when toggled off", async () => {
    mockList.mockResolvedValue([ORG_B]) // showToOrg: true
    mockPatch.mockResolvedValue(undefined)
    mockList.mockResolvedValueOnce([ORG_B]).mockResolvedValue([{ ...ORG_B, config: { ...ORG_B.config, showToOrg: false } }])

    render(<AdminCreditsSection jwt="admin-jwt" />)
    await waitFor(() => expect(screen.getByTestId("admin-credits-table")).toBeInTheDocument())

    const showOrgToggle = screen.getByTestId("show-org-toggle-2")
    expect(showOrgToggle).toHaveAttribute("aria-checked", "true")

    fireEvent.click(showOrgToggle)

    await waitFor(() =>
      expect(mockPatch).toHaveBeenCalledWith("admin-jwt", 2, { showToOrg: false }),
    )
  })
})
