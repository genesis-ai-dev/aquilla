import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { OrgSettingsBilling } from "./OrgSettingsBilling"
import { getOrgBilling, getBillingOffers } from "@/lib/sync/billing"
import type { OrgBilling } from "@/lib/sync/billing"

vi.mock("@/pages/settings/OrgSettingsShell", () => ({
  OrgSettingsShell: ({ children }: { children: React.ReactNode }) => children,
}))
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
  getBillingOffers: vi.fn(),
  startBillingCheckout: vi.fn(),
  startBillingPortal: vi.fn(),
}))

vi.mock("@/lib/sync/cloud-projects", () => ({
  fetchAccessibleProjectsResult: vi.fn(async () => ({ ok: true, projects: [] })),
}))

vi.mock("@/lib/sync/billing-workspace", () => ({
  getBillingWorkspace: vi.fn(async () => ({ orgId: 1, name: "Come and See", scope: null,
    eligibility: { reason: "scope_unconfirmed", offers: [] }, entitlement: null,
    usagePercent: null, checkoutEnabled: false })),
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

beforeEach(() => {
  localStorage.clear()
  vi.mocked(getBillingOffers).mockResolvedValue({ available: false, priceVersion: null,
    entitlementVersion: null, usageInterval: "week", checkoutEnabled: false, offers: [] })
})
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
  it("shows the current Free plan and safe new-plan comparison", async () => {
    mockGet.mockResolvedValueOnce(unpaid)
    renderBilling()
    expect(await screen.findByTestId("billing-plan")).toHaveTextContent("Free")
    expect(await screen.findByRole("tab", { name: "Team & Enterprise" })).toBeDefined()
    expect(screen.queryByTestId("subscribe-field-plan")).toBeNull()
    expect(screen.getByTestId("billing-usage").textContent).toMatch(/rolling seven-day/)
    expect(screen.getByRole("link", { name: "Check covered access" }).getAttribute("href")).toContain("ETEN%20affiliate")
    expect(screen.queryByText(/4 weeks|4-week|\$500|\$200/)).toBeNull()
  })

  it("shows portal but no unavailable add-on purchases on an active Field Plan", async () => {
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
    expect(await screen.findByTestId("manage-billing")).toBeDefined()
    expect(screen.queryByTestId("buy-word-addon")).toBeNull()
    expect(screen.getByTestId("billing-plan").textContent).toMatch(/Field Plan/i)
  })
  it("offers covered Field organizations contact without a Stripe portal", async () => {
    mockGet.mockResolvedValueOnce({ ...unpaid, plan: "field", status: "active", canManage: false })
    renderBilling()
    expect(await screen.findByTestId("billing-plan")).toHaveTextContent("Field Plan")
    expect(screen.queryByTestId("manage-billing")).toBeNull()
    expect(screen.queryByTestId("subscribe-field-plan")).toBeNull()
    expect(screen.getByRole("link", { name: "Check covered access" })).toBeDefined()
  })
  it("keeps new purchases unavailable even if the legacy checkout flag is enabled", async () => {
    mockGet.mockResolvedValueOnce({ ...unpaid, checkoutEnabled: true })
    renderBilling()
    expect(await screen.findByTestId("billing-plan")).toHaveTextContent("Free")
    expect(await screen.findByText(/Plan prices are temporarily unavailable/)).toBeDefined()
    expect(screen.queryByRole("button", { name: /Upgrade to Field/ })).toBeNull()
  })
})
