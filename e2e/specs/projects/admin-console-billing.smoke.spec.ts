import { BillingSettingsPage } from '../../helpers/page-objects/BillingSettings'
import { test, expect } from "../../helpers/multi-user"

/**
 * Admin console → Platform → Billing.
 *
 * Does not complete Stripe Checkout or mutate a live catalog. It asserts a
 * platform admin can open the Billing sub-tab and see the Field Plan catalog
 * plus the org metering table.
 */
test("admin platform billing shows Field Plan catalog", async ({ alice }) => {
  await alice.goto("/admin")
  await expect(alice.getByText(/Orgs|Users|Active projects/i).first()).toBeVisible({ timeout: 10_000 })

  await alice.getByRole("tab", { name: /^Platform$/i }).click()
  await alice.getByRole("tab", { name: /^Billing$/i }).click()
  await expect(alice.getByTestId("admin-billing")).toBeVisible({ timeout: 10_000 })
  await expect(alice.getByRole("heading", { name: /Plan catalog/i })).toBeVisible()
  await expect(alice.getByTestId("save-field-plan")).toBeVisible()
  await expect(alice.getByTestId("admin-billing-orgs")).toBeVisible()
})

test('admin weekly capacity persists and reaches the owning organization billing view', async ({ alice }) => {
  const billing = new BillingSettingsPage(alice)
  await billing.setWeeklyAllowance(alice.orgId, 1000)
  await alice.reload()
  await billing.openPlatformBilling(false)
  await expect(alice.getByTestId(`weekly-allowance-${alice.orgId}`)).toHaveValue('1000')
  await billing.openWorkspace(alice.orgId)
  await expect(alice.getByTestId('billing-usage-percent')).toContainText('0%')
  await expect(alice.getByTestId('billing-workspace')).toContainText('covered access')
})
