// AQU-2068: the one AI % meter. Why these tests matter: this meter is the only
// place a customer learns how much AI is left, and what they may do when it
// runs out. Each state below is a promise from the spec (§6): a number and a
// reset day while metered, a warning at 80%, a stop with real ways out at
// 100%, a greyed meter for BYOK, Unlimited for Enterprise — and in NO state a
// credit, word or dollar figure (R7).
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type { MeterView } from "@/lib/billing/ai-meter"
import { AiMeter, OrgAiMeter } from "./AiMeter"

const RESETS = "2026-10-26T12:00:00Z"
const metered = (percent: number, tier: "free" | "team" = "free"): MeterView => ({
  kind: "metered", tier, percent, resetsAt: RESETS,
  level: percent >= 100 ? "exhausted" : percent >= 80 ? "warning" : "ok",
})

function show(view: MeterView, props: Partial<Parameters<typeof AiMeter>[0]> = {}) {
  return render(<MemoryRouter><AiMeter view={view} orgId={7} canManage {...props} /></MemoryRouter>)
}

/** R7: no amount may reach a customer in any state. Percent signs are fine. */
function expectNoAmounts() {
  const text = document.body.textContent ?? ""
  expect(text).not.toMatch(/credit|word|\$|€|£|USD|cents?\b/i)
  // The only number allowed is the percentage itself.
  expect(text.replace(/\d+%/g, "")).not.toMatch(/\d/)
}

describe("AiMeter", () => {
  it("metered: shows the % and the reset day, nothing else to act on", () => {
    show(metered(42))
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42")
    expect(screen.getByText("42%")).toBeVisible()
    expect(screen.getByText(/^Resets \w+/)).toBeVisible()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.queryByRole("link")).toBeNull()
    expectNoAmounts()
  })

  it("80%: warns softly but stops nothing", () => {
    show(metered(86))
    expect(screen.getByRole("status")).toHaveTextContent("Most of this week's AI is used.")
    expect(screen.queryByTestId("ai-meter-exhausted")).toBeNull()
    expectNoAmounts()
  })

  it("100% on Free: an admin gets Upgrade to Team and Use your own key", () => {
    show(metered(100))
    expect(screen.getByRole("alert")).toHaveTextContent(/used up\. AI actions are paused until \w+\./)
    expect(screen.getByRole("link", { name: "Upgrade to Team" })).toHaveAttribute("href", "/orgs/7/settings/billing")
    // Outside a project there is no AI setup dialog: the org's key settings.
    expect(screen.getByRole("link", { name: "Use your own key" })).toHaveAttribute("href", "/orgs/7/settings/providers")
    expectNoAmounts()
  })

  it("100% on Team: no upgrade to the plan they already have; Enterprise instead", () => {
    show(metered(100, "team"))
    expect(screen.queryByRole("link", { name: "Upgrade to Team" })).toBeNull()
    expect(screen.getByRole("link", { name: "Use your own key" })).toBeVisible()
    expect(screen.getByRole("link", { name: "Talk to us about Enterprise" })).toBeVisible()
  })

  it("100% inside a project: Use your own key opens the AI setup dialog", () => {
    const onUseOwnKey = vi.fn()
    show(metered(100), { onUseOwnKey })
    fireEvent.click(screen.getByRole("button", { name: "Use your own key" }))
    expect(onUseOwnKey).toHaveBeenCalled()
  })

  it("100% for a member: they cannot buy anything, so they are told to ask an admin", () => {
    show(metered(100), { canManage: false })
    expect(screen.getByText("Ask a workspace admin to upgrade or add your own key.")).toBeVisible()
    expect(screen.queryByRole("link", { name: "Upgrade to Team" })).toBeNull()
  })

  it("agent: says agent runs drain the allowance faster", () => {
    show(metered(30), { agent: true })
    expect(screen.getByTestId("ai-meter-agent-note")).toHaveTextContent(/Agent runs use much more/)
  })

  it("BYOK: a greyed meter with no % and the provider tooltip", () => {
    show({ kind: "byok" })
    expect(screen.getByTestId("ai-meter")).toHaveAttribute("data-state", "byok")
    expect(screen.getByText("Not metered")).toBeVisible()
    expect(screen.queryByRole("progressbar")).toBeNull()
    expect(screen.getByRole("button", { name: "Why AI is not metered" })).toBeVisible()
    expectNoAmounts()
  })

  it("Enterprise: Unlimited with the Enterprise mark, and no bar to watch", () => {
    show({ kind: "unlimited" })
    expect(screen.getByText("Unlimited")).toBeVisible()
    expect(screen.getByTestId("enterprise-badge")).toHaveTextContent("Enterprise")
    expect(screen.queryByRole("progressbar")).toBeNull()
    expectNoAmounts()
  })
})

describe("OrgAiMeter", () => {
  it("reads the org's meter and never shows units the server might add", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      orgId: 7, plan: "team", mode: "metered", percentUsed: 12, resetsAt: RESETS,
      // A future field must not leak through the component.
      allowanceUnits: 9600, usedCents: 1234,
    })))
    render(<MemoryRouter><OrgAiMeter jwt="jwt" orgId={7} canManage /></MemoryRouter>)
    expect(await screen.findByText("12%")).toBeVisible()
    expectNoAmounts()
    vi.unstubAllGlobals()
  })
})
