import { test, expect } from "../../helpers/multi-user"

/**
 * AccessModelLegend — expand/collapse in the Matrix view.
 *
 * MembersMatrixView.tsx renders AccessModelLegend above the table.
 * The legend has a toggle button with aria-expanded="false" initially.
 * Clicking it expands to show "Access model legend" details.
 * Clicking again collapses.
 *
 * This spec: navigates to /members → switches to Matrix view →
 * clicks "Access model legend" → aria-expanded becomes true →
 * clicks again → collapses.
 */
test("access model legend expands and collapses in matrix view", async ({ alice }) => {
  await alice.goto("/members")
  await alice.waitForLoadState("networkidle")

  // Switch to Matrix view.
  const matrixBtn = alice.getByRole("button", { name: /Matrix/i })
  await expect(matrixBtn).toBeVisible({ timeout: 10_000 })
  await matrixBtn.click()

  // Access model legend toggle button (aria-expanded).
  const legendToggle = alice.locator('[aria-expanded]').filter({ hasText: /Access model legend/i }).first()
  await expect(legendToggle).toBeVisible({ timeout: 5_000 })
  await expect(legendToggle).toHaveAttribute("aria-expanded", "false")

  // Expand.
  await legendToggle.click()
  await expect(legendToggle).toHaveAttribute("aria-expanded", "true")

  // Content appears — e.g. table with Badge column.
  await expect(alice.getByText(/Badge|grant.*path|org.*role/i).first()).toBeVisible({ timeout: 3_000 })

  // Collapse.
  await legendToggle.click()
  await expect(legendToggle).toHaveAttribute("aria-expanded", "false")
})
