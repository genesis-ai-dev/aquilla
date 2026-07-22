import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * SelectionBar — floating action bar that appears when cells are selected.
 *
 * EditorTable renders a selection checkbox (role="checkbox") on each row.
 * Clicking it selects the cell. SelectionBar appears (aria-label="Selection
 * actions") with "N selected" text and a "Clear selection" button
 * (aria-label="Clear selection").
 *
 * This spec: click the first cell's selection checkbox → SelectionBar
 * appears with "1 selected" → click Clear → SelectionBar disappears.
 */
test("cell selection shows SelectionBar and Clear removes it", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Selection ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Hover the first row to reveal the selection handle.
  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await row.hover()

  // The selection checkbox (role="checkbox") appears on hover.
  const selCheckbox = row.getByRole("checkbox", { name: /Select cell/i })
  await expect(selCheckbox).toBeVisible({ timeout: 3_000 })
  await selCheckbox.click()

  // SelectionBar appears.
  const bar = alice.locator('[aria-label="Selection actions"]')
  await expect(bar).toBeVisible({ timeout: 3_000 })
  await expect(bar.getByText(/1 selected/i)).toBeVisible({ timeout: 3_000 })

  // "Clear selection" button dismisses the bar.
  const clearBtn = alice.getByRole("button", { name: /Clear selection/i })
  await expect(clearBtn).toBeVisible({ timeout: 3_000 })
  await clearBtn.click()
  await expect(bar).not.toBeVisible({ timeout: 3_000 })
})
