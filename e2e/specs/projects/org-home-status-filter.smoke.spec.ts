import { test, expect } from "../../helpers/multi-user"

/**
 * OrgHome — project status filter pills.
 *
 * OrgHome.tsx renders pill-style filter buttons (aria-pressed) for:
 *   All, Active, Stalled, Overdue
 * The "All" filter is selected by default (aria-pressed="true").
 * Clicking a filter pill sets aria-pressed="true" on it.
 *
 * This spec: navigates to the org home → verifies "All" is pressed →
 * clicks "Active" → verifies "Active" becomes pressed and "All" un-pressed
 * → clicks "All" to restore.
 */
test("org home status filter pills toggle active state", async ({ alice }) => {
  await alice.goto("/projects")
  await alice.waitForLoadState("networkidle")

  // "All" filter is pressed by default.
  const allBtn = alice.getByRole("button", { name: /^All$/i })
  await expect(allBtn).toBeVisible({ timeout: 10_000 })
  await expect(allBtn).toHaveAttribute("aria-pressed", "true")

  // Click "Active".
  const activeBtn = alice.getByRole("button", { name: /^Active$/i })
  await expect(activeBtn).toBeVisible({ timeout: 3_000 })
  await activeBtn.click()

  // "Active" is now pressed; "All" is not.
  await expect(activeBtn).toHaveAttribute("aria-pressed", "true", { timeout: 3_000 })
  await expect(allBtn).toHaveAttribute("aria-pressed", "false")

  // Restore by clicking "All".
  await allBtn.click()
  await expect(allBtn).toHaveAttribute("aria-pressed", "true", { timeout: 3_000 })
})
