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
  await expect(alice.getByRole("heading", { name: /Field Plan catalog/i })).toBeVisible()
  await expect(alice.getByTestId("save-field-plan")).toBeVisible()
  await expect(alice.getByTestId("admin-billing-orgs")).toBeVisible()
})
