import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { OrgSettingsBilling } from "./OrgSettingsBilling"
import { getOrgBilling } from "@/lib/sync/billing"
import type { OrgBilling } from "@/lib/sync/billing"

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
  plan: "none",
  status: "none",
  periodStart: null,
  periodEnd: null,
  wordsUsed: 1200,
  trailingYearWords: 1200,
  addonPacks: 0,
  includedWords: 0,
  allowanceWords: null,
  remainingWords: null,
  hardCapWords: null,
  talkToUs: false,
  canSubscribe: true,
  canBuyAddon: false,
  canManage: false,
  stripeConfigured: true,
  fieldPlan: {
    name: "Field Plan",
    intervalDays: 28,
    priceCents: 50_000,
    includedWords: 100_000,
    addonWords: 100_000,
    addonPriceCents: 20_000,
    talkToUsWordsPerYear: 25_000_000,
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
  it("shows the Field Plan subscribe CTA for an unpaid org", async () => {
    mockGet.mockResolvedValueOnce(unpaid)
    renderBilling()
    expect(await screen.findByTestId("subscribe-field-plan")).toBeDefined()
    expect(screen.getByTestId("billing-plan").textContent).toMatch(/No paid plan/i)
    expect(screen.getByTestId("billing-usage").textContent).toMatch(/1,200/)
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
