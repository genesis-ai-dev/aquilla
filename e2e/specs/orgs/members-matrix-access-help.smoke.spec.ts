import { test, expect } from "../../helpers/multi-user"

/**
 * MembersMatrixView — "How access is resolved" help tooltip.
 *
 * The members matrix header has a HelpCircle (?) icon button with
 *   aria-label="How access is resolved"
 * Hovering or focusing it reveals a Tooltip explaining the access model
 * ("Every member's access is the highest role they hold across up to
 * four paths: a direct project grant...").
 *
 * This spec: navigate to /members → verify the help icon exists →
 * hover it → tooltip text becomes visible.
 */
test("members matrix How access is resolved tooltip is visible on hover", async ({ alice }) => {
  await alice.goto("/members")
  await alice.waitForLoadState("networkidle")

  // The "How access is resolved" help button should be visible.
  const helpBtn = alice.locator('[aria-label="How access is resolved"]')
  await expect(helpBtn).toBeVisible({ timeout: 10_000 })

  // Hover to trigger the tooltip.
  await helpBtn.hover()

  // The tooltip content should appear explaining the access model.
  const tooltip = alice.getByText(/highest role they hold/i)
    .or(alice.getByText(/direct project grant/i))
    .or(alice.getByText(/four paths/i))
  await expect(tooltip).toBeVisible({ timeout: 5_000 })
})
