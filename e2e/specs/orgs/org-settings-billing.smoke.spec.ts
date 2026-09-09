import { test, expect, orgRoute } from "../../helpers/multi-user"

/** Existing organization billing boundary: auth → API → billing UI. */
test("org billing settings preserves access while new pricing is unavailable", async ({ alice }) => {
  await alice.goto(orgRoute(alice, "/settings"))
  await expect(alice.locator("h1").filter({ hasText: /Organization settings/i })).toBeVisible()
  await alice.getByRole("link", { name: /Billing & usage/i }).click()
  await expect(alice).toHaveURL(orgRoute(alice, "/settings/billing"))
  await expect(alice.locator("h1").filter({ hasText: /Billing & usage/i })).toBeVisible()
  await expect(alice.getByTestId("billing-plan")).toBeVisible()
  await expect(alice.getByTestId("billing-usage")).toContainText("rolling seven-day")
  await expect(alice.getByRole("tab", { name: "Team & Enterprise" })).toBeVisible()
  await expect(alice.getByText(/Plan prices are temporarily unavailable/)).toBeVisible()
  await expect(alice.getByTestId("subscribe-field-plan")).toHaveCount(0)
  await expect(alice.getByRole("link", { name: "Check covered access" })).toHaveAttribute("href", /ETEN%20affiliate/)
  await expect(alice.getByTestId("billing-plan")).toHaveText("Free")
})
