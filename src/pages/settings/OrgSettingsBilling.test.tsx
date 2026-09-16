import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { Link, MemoryRouter, Route, Routes } from "react-router-dom"
import { OrgProvider } from "@/context/OrgContext"
import { OrgSettingsBilling } from "./OrgSettingsBilling"
import { getOrgBilling, getBillingOffers } from "@/lib/sync/billing"
import { getBillingWorkspace, startWorkspaceBillingPortal, type BillingWorkspace } from "@/lib/sync/billing-workspace"
import { billingOfferLabels } from "../../../db/shared/billing-offers"
import type { OrgBilling } from "@/lib/sync/billing"

vi.mock("@/pages/settings/OrgSettingsShell", () => ({
  OrgSettingsShell: ({ children }: { children: React.ReactNode }) => children,
}))
// AQU-1277: OrgSidebar's useOrgSettings fetches /api/v2/orgs/:id/settings.
// fetchOrgSettings swallows its own failures and returns null, so unmocked it
// silently hit production identity while the tests still passed. null is what
// these tests already observed, so behaviour here is unchanged.
// AQU-1277: OrgProvider loads the project directory via
// fetchAccessibleProjectsResult, which catches its own network errors. Unmocked
// it reached production identity for real while the tests stayed green.
vi.mock("@/lib/sync/cloud-projects", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/sync/cloud-projects")>()),
  fetchAccessibleProjectsResult: vi.fn(async () => ({ ok: true as const, projects: [] })),
}))

vi.mock("@/lib/sync/org-settings", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/sync/org-settings")>()),
  fetchOrgSettings: vi.fn(async () => null),
}))

vi.mock("@/components/AccountSwitcher", () => ({ AccountSwitcher: () => null }))
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "wendi", createdAt: "x" }, loading: false }),
}))
vi.mock("@/lib/frontier/orgs", () => ({
  listMyOrgs: vi.fn(async () => [{ id: 1, name: "Come and See", role: { level: 700, name: "owner" } }, { id: 2, name: "Other workspace", role: { level: 700, name: "owner" } }]),
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
  getBillingWorkspace: vi.fn(),
  startWorkspaceBillingPortal: vi.fn(),
}))

const mockGet = vi.mocked(getOrgBilling)
const emptyWorkspace: BillingWorkspace = { orgId: 1, name: "Come and See", scope: null,
  eligibility: { reason: "scope_unconfirmed", offers: [] }, entitlement: null,
  usagePercent: null, checkoutEnabled: false }
function paidWorkspace(offer: keyof typeof billingOfferLabels, orgId = 1): BillingWorkspace {
  return { ...emptyWorkspace, orgId, scope: offer.startsWith('team') ? 'team' : 'personal',
    eligibility: { reason: 'already_subscribed', offers: [] },
    entitlement: { offer, scope: offer.startsWith('team') ? 'team' : 'personal', billingInterval: 'year',
      priceVersion: 'baseline', entitlementVersion: '2026-09-weekly',
      usagePeriodStart: '2026-09-11T12:00:00.000Z', usagePeriodEnd: '2026-09-18T12:00:00.000Z' } }
}

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
  mockGet.mockReset()
  vi.mocked(getBillingWorkspace).mockReset()
  vi.mocked(getBillingWorkspace).mockResolvedValue(emptyWorkspace)
  vi.mocked(getBillingOffers).mockResolvedValue({ available: false, priceVersion: null,
    entitlementVersion: null, usageInterval: "week", checkoutEnabled: false, offers: [] })
})
afterEach(() => vi.clearAllMocks())

function renderBilling() {
  return render(
    <MemoryRouter initialEntries={["/orgs/1/settings/billing"]}>
      <OrgProvider>
        <Link to="/orgs/2/settings/billing">Switch workspace</Link>
        <Routes>
          <Route path="/orgs/:orgId/settings/billing" element={<OrgSettingsBilling />} />
        </Routes>
      </OrgProvider>
    </MemoryRouter>,
  )
}

describe("OrgSettingsBilling", () => {
  it.each(Object.entries(billingOfferLabels))('shows the recorded %s plan without legacy usage or prices', async (offer, label) => {
    vi.mocked(getBillingWorkspace).mockResolvedValue(paidWorkspace(offer as keyof typeof billingOfferLabels))
    renderBilling()
    expect(await screen.findByTestId('billing-plan')).toHaveTextContent(label)
    expect(screen.getByText('Billed annually.')).toBeVisible()
    expect(screen.getByText('Your workspace’s plan, billing, and AI usage.')).toBeVisible()
    expect(document.body.textContent).not.toMatch(/agent credits|Explore \/ Field/)
    expect(screen.getByTestId('billing-usage')).toHaveTextContent('every seven days from your plan’s activation')
    expect(screen.getByTestId('billing-usage')).not.toHaveTextContent('rolling seven-day')
    expect(screen.queryByTestId('manage-billing')).toBeNull()
    expect(mockGet).not.toHaveBeenCalled()
    expect(getBillingWorkspace).toHaveBeenCalledTimes(1)
  })
  it('shows an unavailable state instead of claiming Free or insufficient permissions', async () => {
    vi.mocked(getBillingWorkspace).mockRejectedValueOnce(new Error('offline'))
    renderBilling()
    expect(await screen.findByRole('alert')).toHaveTextContent('Billing details are unavailable')
    expect(screen.queryByTestId('billing-plan')).toBeNull()
    expect(mockGet).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry billing' }))
    mockGet.mockResolvedValue(unpaid)
    expect(await screen.findByTestId('billing-plan')).toHaveTextContent('Free')
  })
  it('discards an older workspace response after navigation', async () => {
    let resolve!: (workspace: BillingWorkspace) => void
    vi.mocked(getBillingWorkspace).mockImplementationOnce(() => new Promise(r => { resolve = r }))
      .mockResolvedValueOnce(paidWorkspace('team_20x', 2))
    renderBilling()
    await waitFor(() => expect(getBillingWorkspace).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('link', { name: 'Switch workspace' }))
    expect(await screen.findByTestId('billing-plan')).toHaveTextContent('Team 20×')
    await act(async () => { resolve(paidWorkspace('pro')) })
    expect(screen.getByTestId('billing-plan')).toHaveTextContent('Team 20×')
    expect(mockGet).not.toHaveBeenCalled()
  })

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

it.each(['payment_failed', 'paid_period_ended', 'paid'] as const)(
  'renders authoritative %s access without changing the subscription or showing ledger units', async reason => {
    const workspace = paidWorkspace('pro')
    workspace.entitlement!.access = { offer: reason === 'paid' ? 'pro' : 'free', reason,
      paidThrough: '2026-10-01T00:00:00.000Z', cancelAtPeriodEnd: reason === 'paid' }
    vi.mocked(getBillingWorkspace).mockResolvedValue(workspace)
    renderBilling()
    const access = await screen.findByTestId('billing-access')
    expect(access).toHaveTextContent(reason === 'payment_failed' ? 'Payment failed.'
      : reason === 'paid_period_ended' ? 'Your paid period has ended.' : 'Paid access continues through')
    if (reason !== 'paid') expect(access).toHaveTextContent('Free')
    expect(access).not.toHaveTextContent(/credits|25|50/)
    expect(screen.getByTestId('billing-plan')).toHaveTextContent('Pro')
    expect(mockGet).not.toHaveBeenCalled()
  },
)

it('routes native paid billing to the workspace portal and preserves access on failure', async () => {
  vi.mocked(getBillingWorkspace).mockResolvedValue({ ...paidWorkspace('pro'), portalEnabled: true })
  vi.mocked(startWorkspaceBillingPortal).mockRejectedValueOnce(new Error('Portal temporarily unavailable'))
  renderBilling()
  fireEvent.click(await screen.findByRole('button', { name: 'Manage billing' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Portal temporarily unavailable')
  expect(startWorkspaceBillingPortal).toHaveBeenCalledWith('jwt', 1)
  expect(screen.getByText('Use Manage billing to update this workspace’s subscription in Stripe.')).toBeVisible()
  expect(screen.queryByText(/Changes will be available when billing management is ready/)).toBeNull()
  expect(screen.getByTestId('billing-plan')).toHaveTextContent('Pro')
  expect(screen.getByRole('button', { name: 'Manage billing' })).toBeEnabled()
  expect(getBillingOffers).not.toHaveBeenCalled()
})
