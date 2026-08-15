import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { BillingUsagePanel } from "./BillingUsagePanel"
import { getOrgBilling } from "@/lib/sync/billing"
import { ROLE } from "@/lib/frontier/roles"

vi.mock("@/lib/sync/billing", () => ({ getOrgBilling: vi.fn() }))
const mockGet = vi.mocked(getOrgBilling)

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

describe("BillingUsagePanel", () => {
  it("does not fetch or render for translators", async () => {
    render(
      <MemoryRouter>
        <BillingUsagePanel jwt="jwt" orgId={1} orgRoleLevel={ROLE.CONTRIBUTOR} />
      </MemoryRouter>,
    )
    expect(mockGet).not.toHaveBeenCalled()
    expect(screen.queryByTestId("billing-usage-panel")).toBeNull()
  })

  it("renders word usage for a maintainer", async () => {
    mockGet.mockResolvedValueOnce({
      plan: "field",
      status: "active",
      periodStart: null,
      periodEnd: null,
      wordsUsed: 25000,
      trailingYearWords: 25000,
      addonPacks: 0,
      includedWords: 100000,
      allowanceWords: 100000,
      remainingWords: 75000,
      hardCapWords: null,
      talkToUs: false,
      canSubscribe: false,
      canBuyAddon: true,
      canManage: true,
      stripeConfigured: true,
      fieldPlan: {
        name: "Field Plan",
        intervalDays: 28,
        priceCents: 50000,
        includedWords: 100000,
        addonWords: 100000,
        addonPriceCents: 20000,
        talkToUsWordsPerYear: 25000000,
      },
    })
    render(
      <MemoryRouter>
        <BillingUsagePanel jwt="jwt" orgId={1} orgRoleLevel={ROLE.MAINTAINER} />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByTestId("billing-usage-panel")).toBeDefined())
    expect(screen.getByText(/25,000/)).toBeDefined()
  })
})
