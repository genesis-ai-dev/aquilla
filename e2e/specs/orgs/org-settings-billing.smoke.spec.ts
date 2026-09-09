import { test, expect, orgRoute } from "../../helpers/multi-user"

/**
 * Org billing settings — Field Plan subscribe surface.
 *
 * Does not complete a Stripe Checkout (that needs a live card + webhook).
 * It asserts the maintainer can open Billing & usage and see the unpaid
 * Field Plan CTA plus shared usage guidance.
 */
test("org billing settings shows Field Plan subscribe CTA", async ({ alice }) => {
  await alice.goto(orgRoute(alice, "/settings"))
  await expect(alice.locator("h1").filter({ hasText: /Organization settings/i })).toBeVisible()
  await alice.getByRole("link", { name: /Billing & usage/i }).click()
  await expect(alice).toHaveURL(orgRoute(alice, "/settings/billing"))
  await expect(alice.locator("h1").filter({ hasText: /Billing & usage/i })).toBeVisible()
  await expect(alice.getByTestId("billing-plan")).toBeVisible()
  await expect(alice.getByTestId("billing-usage")).toContainText("rolling seven-day")
  await expect(alice.getByTestId("subscribe-field-plan")).toBeDisabled()
  await expect(alice.getByRole("link", { name: "Check covered access" })).toHaveAttribute("href", /ETEN%20affiliate/)
  await expect(alice.getByText(/Field Plan/i).first()).toBeVisible()
})
