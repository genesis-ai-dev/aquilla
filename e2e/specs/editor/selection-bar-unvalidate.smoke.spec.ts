import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * SelectionBar — "Remove my validations" bulk unvalidate.
 *
 * After validating a cell, selecting it and clicking "Remove my validations"
 * in the SelectionBar (role="toolbar" aria-label="Selection actions")
 * removes the current user's validation.
 *
 * This spec: import file → edit cell → validate it → select it →
 * clicks "Remove my validations" → verifies the button was enabled and
 * clickable (cell unvalidation fires without error).
 */
test("SelectionBar Remove my validations button removes validation", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Unvalidate ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Edit the first cell.
  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await ws.editCell(0, "validated-text")
  // Validate the cell.
  await ws.validateCell(0)

  // Select the first cell's checkbox.
  await row.hover()
  const checkbox = row.getByRole("checkbox").first()
  await expect(checkbox).toBeVisible({ timeout: 5_000 })
  await checkbox.check()

  // SelectionBar appears.
  const selBar = alice.locator('[aria-label="Selection actions"]')
  await expect(selBar).toBeVisible({ timeout: 5_000 })

  // "Remove my validations" button is visible and enabled.
  const removeValBtn = selBar.getByRole("button", { name: /Remove my validations/i })
  await expect(removeValBtn).toBeVisible({ timeout: 3_000 })
  await expect(removeValBtn).toBeEnabled({ timeout: 3_000 })
  await removeValBtn.click()

  // Assert the actual state transition; a click without a persisted
  // unvalidation is not success.
  await expect(ws.validationToggle(0)).toHaveAttribute("aria-pressed", "false", {
    timeout: 15_000,
  })
  await expect(removeValBtn).toBeDisabled()
})
