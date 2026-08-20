import { test, expect, orgRoute } from "../../helpers/multi-user"

/**
 * Org billing settings — Field Plan subscribe surface.
 *
 * Does not complete a Stripe Checkout (that needs a live card + webhook).
 * It asserts the maintainer can open Billing & usage and see the unpaid
 * Field Plan CTA plus recorded word usage.
 */
test("org billing settings shows Field Plan subscribe CTA", async ({ alice }) => {
  await alice.goto(orgRoute(alice, "/settings"))
  await expect(alice.locator("h1").filter({ hasText: /Organization settings/i })).toBeVisible()
  await alice.getByRole("link", { name: /Billing & usage/i }).click()
  await expect(alice).toHaveURL(orgRoute(alice, "/settings/billing"))
  await expect(alice.locator("h1").filter({ hasText: /Billing & usage/i })).toBeVisible()
  await expect(alice.getByTestId("billing-plan")).toBeVisible()
  await expect(alice.getByTestId("billing-usage")).toBeVisible()
  await expect(alice.getByText(/Field Plan/i).first()).toBeVisible()
})
