import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * SelectionBar — Clear selection (×) button.
 *
 * When at least one cell is selected, SelectionBar renders a
 * (aria-label="Clear selection") × button. Clicking it calls clearSelection()
 * and the SelectionBar disappears.
 *
 * This spec: selects a cell → verifies SelectionBar is visible →
 * clicks "Clear selection" → SelectionBar disappears.
 */
test("SelectionBar Clear selection button dismisses the bar", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `ClearSel ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Select the first cell's checkbox.
  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await row.hover()
  const checkbox = row.getByRole("checkbox").first()
  await expect(checkbox).toBeVisible({ timeout: 5_000 })
  await checkbox.check()

  // SelectionBar appears.
  const selBar = alice.locator('[aria-label="Selection actions"]')
  await expect(selBar).toBeVisible({ timeout: 5_000 })

  // Click "Clear selection".
  const clearBtn = selBar.getByRole("button", { name: /Clear selection/i })
  await expect(clearBtn).toBeVisible({ timeout: 3_000 })
  await clearBtn.click()

  // SelectionBar disappears.
  await expect(selBar).not.toBeVisible({ timeout: 3_000 })
})
