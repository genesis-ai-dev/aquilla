/**
 * Tests for CreditsDial — the agent-surface org credit gauge.
 *
 * WHY these tests matter:
 *   The dial lives in the agent UI, which every project member can open — so
 *   the translator-never-sees-it invariant from CreditsPanel applies here with
 *   MORE exposure, not less. Same double gate: role check client-side, 403 →
 *   null server-side. And the surface must stay credits-only: no raw $.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { renderWithTooltips, expectTooltip } from "@/test-utils/tooltip"
import { CreditsDial } from "./CreditsDial"
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
  day: { totalCredits: 400, byRail: { llm: 200, agent: 150, tts: 50 }, agentCredits: 150 },
  week: { totalCredits: 1800, byRail: { llm: 900, agent: 700, tts: 200 }, agentCredits: 700 },
  remaining: { daily: 600, weekly: 3200, agentDaily: 450, agentWeekly: 2300 },
}

describe("CreditsDial — visibility gates", () => {
  it("never renders nor fetches for a translator (role gate)", () => {
    mockGetOrgCredits.mockResolvedValue(SAMPLE_DATA)
    const { container } = render(
      <CreditsDial jwt="jwt" orgId={1} orgRoleLevel={ROLE.MAINTAINER - 1} />,
    )
    expect(container.innerHTML).toBe("")
    expect(mockGetOrgCredits).not.toHaveBeenCalled()
  })

  it("self-hides when the server returns 403 → null (flag gate)", async () => {
    mockGetOrgCredits.mockResolvedValue(null)
    const { container } = renderWithTooltips(<CreditsDial jwt="jwt" orgId={1} orgRoleLevel={ROLE.MAINTAINER} />)
    await waitFor(() => expect(mockGetOrgCredits).toHaveBeenCalled())
    expect(container.innerHTML).toBe("")
  })
})

describe("CreditsDial — maintainer view", () => {
  it("shows only the ring by default; today's spend is on the hover tooltip, not inline (AQU-671)", async () => {
    mockGetOrgCredits.mockResolvedValue(SAMPLE_DATA)
    renderWithTooltips(<CreditsDial jwt="jwt" orgId={1} orgRoleLevel={ROLE.MAINTAINER} />)
    const dial = await screen.findByTestId("credits-dial")
    // No always-on inline number beside the ring — the icon stands alone.
    expect(dial.textContent).not.toContain("150 cr")
    expect(dial.querySelector("svg")).not.toBeNull()
    // Today's agent-credit spend is surfaced on hover. AppTooltip replaced the
    // native title, so assert the tooltip that opens rather than an attribute.
    expect(dial).toHaveAttribute("aria-label", "Agent credits used today: 150 cr")
    await expectTooltip(dial, "Agent credits used today: 150 cr")
    // Still credits-only: no raw $.
    expect(screen.getByRole("tooltip").textContent).not.toContain("$")
  })

  it("never surfaces 'NaN cr' when today's agent credits are non-numeric (AQU-671)", async () => {
    mockGetOrgCredits.mockResolvedValue({
      ...SAMPLE_DATA,
      day: { ...SAMPLE_DATA.day, agentCredits: NaN },
    })
    renderWithTooltips(<CreditsDial jwt="jwt" orgId={1} orgRoleLevel={ROLE.MAINTAINER} />)
    const dial = await screen.findByTestId("credits-dial")
    expect(dial).toHaveAttribute("aria-label", "Agent credits used today: 0 cr")
    await expectTooltip(dial, "Agent credits used today: 0 cr")
    expect(screen.getByRole("tooltip").textContent).not.toContain("NaN")
    // The ring dasharray must stay finite even with a NaN spend.
    const ring = dial.querySelectorAll("circle")[1]
    expect(ring.getAttribute("stroke-dasharray") ?? "").not.toContain("NaN")
  })

  it("draws the ring as a chip-backed 16px gauge, still with no inline number", async () => {
    mockGetOrgCredits.mockResolvedValue(SAMPLE_DATA)
    renderWithTooltips(<CreditsDial jwt="jwt" orgId={1} orgRoleLevel={ROLE.MAINTAINER} />)
    const dial = await screen.findByTestId("credits-dial")
    expect(dial.querySelector("svg")?.getAttribute("class")).toContain("h-4")
    expect(dial.className).toContain("rounded-full")
    // The heavier treatment is styling only — the ring still stands alone (AQU-671).
    expect(dial.textContent).not.toContain("150 cr")
    expect(dial).toHaveAttribute("aria-label", "Agent credits used today: 150 cr")
    // The thicker arc must stay inside the 12x12 box: r + stroke/2 <= 6.
    const ring = dial.querySelectorAll("circle")[1]
    const r = Number(ring.getAttribute("r"))
    const stroke = Number(ring.getAttribute("stroke-width"))
    expect(r + stroke / 2).toBeLessThanOrEqual(6)
  })

  it("opens a popover with agent + all-rail day/week detail on click", async () => {
    mockGetOrgCredits.mockResolvedValue(SAMPLE_DATA)
    renderWithTooltips(<CreditsDial jwt="jwt" orgId={1} orgRoleLevel={ROLE.MAINTAINER} />)
    fireEvent.click(await screen.findByTestId("credits-dial"))

    const popover = await screen.findByTestId("credits-dial-popover")
    expect(screen.getByTestId("dial-agent-day")).toHaveTextContent("150 cr / 600 cr")
    expect(screen.getByTestId("dial-agent-week")).toHaveTextContent("700 cr / 3,000 cr")
    expect(screen.getByTestId("dial-total-day")).toHaveTextContent("400 cr / 1,000 cr")
    expect(screen.getByTestId("dial-total-week")).toHaveTextContent("1,800 cr / 5,000 cr")
    // Remaining-today summary, still credits-only.
    expect(popover).toHaveTextContent("450 cr agent credits left today")
    expect(popover.textContent).not.toContain("$")
  })
})
