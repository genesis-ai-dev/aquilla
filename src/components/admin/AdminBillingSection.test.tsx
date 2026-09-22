import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { AdminBillingSection } from "./AdminBillingSection"
import { fmtShortCalendarDate } from "@/lib/format-date"
import type { AdminBillingOrg, AdminBillingPlans } from "@/lib/frontier/admin"

vi.mock("@/lib/frontier/admin", () => ({
  getAdminBillingPlans: vi.fn(),
  getAdminBillingOrgs: vi.fn(),
  updateAdminBillingPlans: vi.fn(),
  patchAdminBillingOrg: vi.fn(),
  grantAdminWords: vi.fn(),
  resetAdminWords: vi.fn(),
  grantAdminCredits: vi.fn(),
  resetAdminCredits: vi.fn(),
}))

import {
  getAdminBillingOrgs,
  getAdminBillingPlans,
  grantAdminWords,
  updateAdminBillingPlans,
} from "@/lib/frontier/admin"

const mockPlans = vi.mocked(getAdminBillingPlans)
const mockOrgs = vi.mocked(getAdminBillingOrgs)
const mockSave = vi.mocked(updateAdminBillingPlans)
const mockGrant = vi.mocked(grantAdminWords)

const CATALOG: AdminBillingPlans = {
  plan: {
    name: "Field Plan",
    intervalDays: 28,
    priceCents: 50_000,
    includedWords: 100_000,
    addonWords: 100_000,
    addonPriceCents: 20_000,
    talkToUsWordsPerYear: 25_000_000,
    stripePriceField: "price_field",
    stripePriceAddon: "price_addon",
    wordsPerCredit: 100,
    exploreCreditsPerCycle: 100,
    fieldCreditsPerCycle: 1_000,
    addonCredits: 1_000,
    enterpriseCreditsPerLanguagePerYear: 10_000,
  },
  version: 1,
  stripeConfigured: false,
  note: "Stripe is not configured.",
}

const ORG: AdminBillingOrg = {
  orgId: 1,
  orgName: "Come and See",
  plan: "field",
  status: "active",
  wordsUsed: 12_000,
  allowanceWords: 100_000,
  remainingWords: 88_000,
  addonPacks: 0,
  complimentaryWords: 0,
  hardCapWords: null,
  periodStart: null,
  periodEnd: null,
  creditsUsed: 120,
  allowanceCredits: 1_000,
  remainingCredits: 880,
  complimentaryCredits: 0,
  includedCredits: 1_000,
  languageCount: 1,
  includedCreditsOverride: null,
  billedLanguageCountOverride: null,
  wordsPerCredit: 100,
}

/** Enterprise partner with a persisted capacity period — the AQU-1212 case. */
const ENTERPRISE_ORG: AdminBillingOrg = {
  ...ORG,
  orgId: 2,
  orgName: "Biblica",
  plan: "enterprise",
  periodStart: "2026-01-01T00:00:00.000Z",
  periodEnd: "2026-01-29T00:00:00.000Z",
  languageCount: 5,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockPlans.mockResolvedValue(CATALOG)
  mockOrgs.mockResolvedValue([ORG, ENTERPRISE_ORG])
  mockSave.mockResolvedValue({ plan: CATALOG.plan, version: 2, warnings: [] })
  mockGrant.mockResolvedValue()
})
afterEach(() => vi.restoreAllMocks())

describe("AdminBillingSection", () => {
  it("shows the Field Plan catalog and org usage", async () => {
    render(<AdminBillingSection jwt="jwt" />)
    expect(await screen.findByTestId("admin-billing")).toBeDefined()
    expect(screen.getByTestId("save-field-plan")).toBeDefined()
    expect(screen.getByTestId("admin-words-1").textContent).toMatch(/120/)
  })

  it("saves catalog amounts as cents", async () => {
    render(<AdminBillingSection jwt="jwt" />)
    await screen.findByTestId("save-field-plan")
    fireEvent.click(screen.getByTestId("save-field-plan"))
    await waitFor(() => expect(mockSave).toHaveBeenCalled())
    expect(mockSave.mock.calls[0][1]).toMatchObject({
      ifMatchVersion: 1,
      priceCents: 50_000,
      fieldCreditsPerCycle: 1_000,
      wordsPerCredit: 100,
    })
  })

  it("grants 100k courtesy words", async () => {
    render(<AdminBillingSection jwt="jwt" />)
    fireEvent.click(await screen.findByTestId("grant-words-1"))
    await waitFor(() => expect(mockGrant).toHaveBeenCalledWith("jwt", 1, 100_000, "admin courtesy grant"))
  })

  // AQU-1212: an admin provisioning a partner org must be able to find it. With
  // every org on one unfiltered page, the assignment controls are unreachable
  // at partner scale (150+ orgs), so the search field is part of the contract.
  it("filters the org table by name so a partner org can be found", async () => {
    render(<AdminBillingSection jwt="jwt" />)
    expect(await screen.findByTestId("admin-words-1")).toBeDefined()
    expect(screen.getByTestId("admin-words-2")).toBeDefined()

    fireEvent.change(screen.getByLabelText("Search organizations…"), { target: { value: "Biblica" } })

    await waitFor(() => expect(screen.queryByTestId("admin-words-1")).toBeNull())
    expect(screen.getByTestId("admin-words-2")).toBeDefined()
  })

  it("finds an org by its numeric id", async () => {
    render(<AdminBillingSection jwt="jwt" />)
    await screen.findByTestId("admin-words-1")

    fireEvent.change(screen.getByLabelText("Search organizations…"), { target: { value: "2" } })

    await waitFor(() => expect(screen.queryByTestId("admin-words-1")).toBeNull())
    expect(screen.getByTestId("admin-words-2")).toBeDefined()
  })

  // AQU-1212: "capacity" is meaningless without the period it applies to. The
  // API already returned periodStart/periodEnd; the table used to discard them.
  it("shows the capacity period an assignment applies to", async () => {
    render(<AdminBillingSection jwt="jwt" />)
    const period = await screen.findByTestId("admin-period-2")
    // Format through the same helper the cell uses, so this asserts "both ends
    // of the period are rendered" rather than pinning a locale/timezone string.
    expect(period.textContent).toContain(fmtShortCalendarDate(ENTERPRISE_ORG.periodStart))
    expect(period.textContent).toContain(fmtShortCalendarDate(ENTERPRISE_ORG.periodEnd))
    expect(period.textContent).not.toMatch(/No period set/)
  })

  it("says so plainly when an org has no billing period on record", async () => {
    render(<AdminBillingSection jwt="jwt" />)
    const period = await screen.findByTestId("admin-period-1")
    expect(period.textContent).toMatch(/No period set/)
  })
})
