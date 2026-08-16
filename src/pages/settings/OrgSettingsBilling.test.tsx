import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { OrgSettingsBilling } from "./OrgSettingsBilling"
import { getOrgBilling } from "@/lib/sync/billing"
import type { OrgBilling } from "@/lib/sync/billing"

vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "wendi", createdAt: "x" }, loading: false }),
}))
vi.mock("@/lib/frontier/orgs", () => ({
  listMyOrgs: vi.fn(async () => [{ id: 1, name: "Come and See", role: { level: 700, name: "owner" } }]),
  renameOrg: vi.fn(async () => {}),
}))
vi.mock("@/lib/sync/billing", () => ({
  getOrgBilling: vi.fn(),
  startBillingCheckout: vi.fn(),
  startBillingPortal: vi.fn(),
}))

const mockGet = vi.mocked(getOrgBilling)

const unpaid: OrgBilling = {
  plan: "explore",
  status: "none",
  periodStart: null,
  periodEnd: null,
  wordsUsed: 1200,
  trailingYearWords: 1200,
  addonPacks: 0,
  includedWords: 10_000,
  allowanceWords: 10_000,
  remainingWords: 8_800,
  hardCapWords: null,
  talkToUs: false,
  creditsUsed: 12,
  allowanceCredits: 100,
  remainingCredits: 88,
  includedCredits: 100,
  wordsPerCredit: 100,
  canSubscribe: true,
  canBuyAddon: false,
  canManage: false,
  checkoutEnabled: false,
  stripeConfigured: true,
  fieldPlan: {
    name: "Field Plan",
    intervalDays: 28,
    priceCents: 50_000,
    includedWords: 100_000,
    addonWords: 100_000,
    addonPriceCents: 20_000,
    talkToUsWordsPerYear: 25_000_000,
    wordsPerCredit: 100,
    exploreCreditsPerCycle: 100,
    fieldCreditsPerCycle: 1_000,
    addonCredits: 1_000,
    enterpriseCreditsPerLanguagePerYear: 10_000,
  },
}

beforeEach(() => localStorage.clear())
afterEach(() => vi.clearAllMocks())

function renderBilling() {
  return render(
    <MemoryRouter initialEntries={["/orgs/1/settings/billing"]}>
      <OrgProvider>
        <Routes>
          <Route path="/orgs/:orgId/settings/billing" element={<OrgSettingsBilling />} />
        </Routes>
      </OrgProvider>
    </MemoryRouter>,
  )
}

describe("OrgSettingsBilling", () => {
  it("shows Explore plus a Coming soon Field Plan button", async () => {
    mockGet.mockResolvedValueOnce(unpaid)
    renderBilling()
    const subscribe = await screen.findByTestId("subscribe-field-plan")
    expect(subscribe).toBeDefined()
    expect((subscribe as HTMLButtonElement).disabled).toBe(true)
    expect(subscribe.textContent).toMatch(/Coming soon/i)
    expect(screen.getByTestId("billing-plan").textContent).toMatch(/Explore/i)
    expect(screen.getByTestId("billing-usage").textContent).toMatch(/12/)
    expect(screen.getByTestId("billing-usage").textContent).not.toMatch(/1,200/)
  })

  it("shows add-on + portal controls on an active Field Plan", async () => {
    mockGet.mockResolvedValueOnce({
      ...unpaid,
      plan: "field",
      status: "active",
      wordsUsed: 80_000,
      allowanceWords: 100_000,
      remainingWords: 20_000,
      includedWords: 100_000,
      creditsUsed: 800,
      allowanceCredits: 1_000,
      remainingCredits: 200,
      includedCredits: 1_000,
      canSubscribe: false,
      canBuyAddon: true,
      canManage: true,
    })
    renderBilling()
    expect(await screen.findByTestId("buy-word-addon")).toBeDefined()
    expect(screen.getByTestId("manage-billing")).toBeDefined()
    expect(screen.getByTestId("billing-plan").textContent).toMatch(/Field Plan/i)
  })
})
