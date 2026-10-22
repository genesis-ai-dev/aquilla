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
  patchAdminWeeklyAllowance: vi.fn(),
  grantAdminWords: vi.fn(),
  resetAdminWords: vi.fn(),
  grantAdminCredits: vi.fn(),
  resetAdminCredits: vi.fn(),
  patchAdminOrgPlan: vi.fn(),
  getAdminWouldBlock: vi.fn(),
}))

import {
  getAdminWouldBlock,
  patchAdminOrgPlan,
  patchAdminWeeklyAllowance,
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
    freeWeeklyRawUsd: 1,
    teamMultipleOfFree: 24,
    unitsPerRawUsd: 400,
    teamCost: {
      teamWeeklyRawUsd: 24,
      teamWeeklyRevenueUsd: 5_000 / 52,
      costShareOfRevenue: 24 / (5_000 / 52),
      maxCostShare: 0.25,
      exceedsMaxShare: false,
    },
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
  weeklyAllowance: null,
  tier: "team",
  contractEndsAt: null,
  resolvedTier: "team",
  planSource: "stored",
  graceEndsAt: null,
  effectiveWeeklyAllowance: 9_600,
}

/** Enterprise partner with a persisted capacity period — the AQU-1212 case. */
const ENTERPRISE_ORG: AdminBillingOrg = {
  ...ORG,
  orgId: 2,
  orgName: "Biblica",
  plan: "enterprise",
  tier: "enterprise",
  resolvedTier: "enterprise",
  effectiveWeeklyAllowance: null,
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
  vi.mocked(getAdminWouldBlock).mockResolvedValue({ meterMode: "shadow", orgs: [] })
  vi.mocked(patchAdminOrgPlan).mockResolvedValue()
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

describe("AdminBillingSection — AQU-942: the resolved shell survives revalidation", () => {
  it("shows a first-load placeholder only before anything resolves", async () => {
    let release: (plans: AdminBillingPlans) => void = () => {}
    mockPlans.mockImplementationOnce(
      () => new Promise<AdminBillingPlans>((resolve) => { release = resolve }),
    )
    render(<AdminBillingSection jwt="jwt" />)

    expect(screen.getByRole("status", { name: "Loading billing" })).toHaveAttribute(
      "aria-busy",
      "true",
    )

    release(CATALOG)
    expect(await screen.findByTestId("admin-billing")).toBeDefined()
    expect(screen.queryByRole("status", { name: "Loading billing" })).toBeNull()
  })

  it("keeps the catalog form and org table mounted while a grant revalidates", async () => {
    // WHY: `act` re-fetches after every grant/reset, flipping `loading` back
    // on. Gating the section on `loading` blanked the whole tab after each
    // action, losing the table's sort/scroll and flashing the form away.
    render(<AdminBillingSection jwt="jwt" />)
    await screen.findByTestId("save-field-plan")

    let release: (plans: AdminBillingPlans) => void = () => {}
    mockPlans.mockImplementationOnce(
      () => new Promise<AdminBillingPlans>((resolve) => { release = resolve }),
    )
    fireEvent.click(screen.getByTestId("grant-words-1"))
    await waitFor(() => expect(mockGrant).toHaveBeenCalled())

    expect(screen.getByTestId("admin-billing")).toBeDefined()
    expect(screen.getByTestId("save-field-plan")).toBeDefined()
    expect(screen.queryByRole("status", { name: "Loading billing" })).toBeNull()

    release(CATALOG)
    await waitFor(() => expect(screen.getByTestId("admin-billing")).toBeDefined())
  })
})

// AQU-2056: the admin sets Free in raw provider dollars; the server derives Team
// from it, so the old unit field would no longer change what the meter enforces.
it('saves the runtime Free weekly allowance in raw dollars through the versioned catalog', async () => {
  render(<AdminBillingSection jwt="jwt" />)
  fireEvent.change(await screen.findByLabelText('Free weekly AI allowance ($ raw provider cost; Team follows)'), {
    target: { value: '1.5' },
  })
  fireEvent.click(screen.getByTestId('save-field-plan'))
  await waitFor(() => expect(mockSave).toHaveBeenCalledWith('jwt',
    expect.objectContaining({ freeWeeklyRawUsd: 1.5, ifMatchVersion: 1 })))
  expect(mockSave.mock.calls[0]![1]).not.toHaveProperty('freeWeeklyAllowance')
})
it('sets and clears a partner weekly grant without changing its Stripe plan', async () => {
  vi.mocked(patchAdminWeeklyAllowance).mockResolvedValue()
  render(<AdminBillingSection jwt="jwt" />)
  const input = await screen.findByLabelText('weekly allowance for Biblica')
  // AQU-2067: admins state allowances in raw provider dollars, not meter units.
  fireEvent.change(input, { target: { value: '2.5' } })
  fireEvent.blur(input)
  await waitFor(() => expect(patchAdminWeeklyAllowance).toHaveBeenCalledWith('jwt', 2, 2.5))
})

// AQU-2067 (unified billing T10). Team is a multiple of Free, so the admin
// must see Team's worst-case raw cost before saving a Free change, and be
// warned when it passes 25% of Team revenue (spec Q7).
describe('Free cap → Team implied cost', () => {
  it('shows Team at 24× Free and warns only once Team passes 25% of revenue', async () => {
    render(<AdminBillingSection jwt="jwt" />)
    const line = await screen.findByTestId('team-implied-cost')
    expect(line.textContent).toMatch(/\$24\.00\/week raw/)
    expect(screen.queryByTestId('team-cost-warning')).toBeNull()
    fireEvent.change(screen.getByLabelText('Free weekly AI allowance ($ raw provider cost; Team follows)'), {
      target: { value: '2' },
    })
    expect(screen.getByTestId('team-implied-cost').textContent).toMatch(/\$48\.00\/week raw/)
    expect(screen.getByTestId('team-cost-warning')).toBeDefined()
  })
})

describe('per-org plan control', () => {
  it('replaces Explore/Field with free | team | enterprise and saves the plan', async () => {
    render(<AdminBillingSection jwt="jwt" />)
    const select = (await screen.findByLabelText('plan for Come and See')) as HTMLSelectElement
    expect([...select.options].map(o => o.value)).toEqual(['free', 'team', 'enterprise'])
    fireEvent.change(select, { target: { value: 'enterprise' } })
    await waitFor(() => expect(patchAdminOrgPlan).toHaveBeenCalledWith('jwt', 1, { tier: 'enterprise', contractEndsAt: null }))
  })

  it('sets an Enterprise contract end date', async () => {
    render(<AdminBillingSection jwt="jwt" />)
    const date = await screen.findByLabelText('contract end for Biblica')
    fireEvent.change(date, { target: { value: '2027-01-31' } })
    fireEvent.blur(date)
    await waitFor(() => expect(patchAdminOrgPlan).toHaveBeenCalledWith('jwt', 2,
      { tier: 'enterprise', contractEndsAt: '2027-01-31T00:00:00Z' }))
  })

  it('shows the grace state after an Enterprise contract ends', async () => {
    mockOrgs.mockResolvedValue([{
      ...ENTERPRISE_ORG, contractEndsAt: '2026-10-10T00:00:00.000Z', resolvedTier: 'team',
      planSource: 'contract_grace', graceEndsAt: '2026-10-24T00:00:00.000Z', effectiveWeeklyAllowance: 9_600,
    }])
    render(<AdminBillingSection jwt="jwt" />)
    expect((await screen.findByTestId('plan-status-2')).textContent).toBe('Contract ended · Team-sized grace until 2026-10-24')
  })
})

describe('would-block report', () => {
  it('lists each org with its users and rails for both periods', async () => {
    vi.mocked(getAdminWouldBlock).mockResolvedValue({
      meterMode: 'shadow',
      orgs: [{
        orgId: 1, orgName: 'Come and See', tier: 'free', pctUsed: 1.2, lastAt: '2026-10-20T00:00:00Z',
        current: { requests: 3, rawUsd: 1.5, byRail: { llm: 2, agent: 1 }, users: [
          { userId: 4, username: 'wendi', requests: 2, rails: ['llm'] },
          { userId: null, username: null, requests: 1, rails: ['agent'] },
        ] },
        previous: { requests: 0, rawUsd: 0, byRail: {}, users: [] },
      }],
    })
    render(<AdminBillingSection jwt="jwt" />)
    const row = await screen.findByTestId('would-block-1')
    expect(row.textContent).toContain('120%')
    expect(row.textContent).toContain('3 blocked · $1.50 raw')
    expect(row.textContent).toContain('wendi ×2 (llm)')
    expect(row.textContent).toContain('background work ×1 (agent)')
    expect(screen.getByTestId('meter-mode').textContent).toContain('shadow')
  })
})
