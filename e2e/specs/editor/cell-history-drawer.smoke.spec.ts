import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Cell action rail — "Edit history" button → full HistoryDrawer.
 *
 * The expansion panel no longer has a History tab; edit history is reached
 * via the single "Edit history" button on the CellActionRail (revealed on
 * row hover), which opens the full-page HistoryDrawer (heading
 * "Edit history").
 *
 * This spec: import a file → edit a cell → hover the row → click the
 * "Edit history" rail button → assert HistoryDrawer heading "Edit history"
 * is visible → close drawer.
 */
test("cell rail Edit history button opens full HistoryDrawer", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `CellHist ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Edit the cell so there's at least one history entry.
  await ws.activateTargetCell(0)
  await alice.keyboard.press("End")
  await alice.keyboard.insertText(" hist-test")
  // Click away to commit.
  await alice.locator("aside, header").first().click()

  const row = ws.cellRow(0)

  // Hover to reveal CellActionRail, then open the history drawer.
  await row.hover()
  const historyBtn = row.locator('button[aria-label="Edit history"]')
  await expect(historyBtn).toBeVisible({ timeout: 5_000 })
  await historyBtn.click()

  // HistoryDrawer opens — heading "Edit history" is visible.
  await expect(alice.getByText(/Edit history/i).first()).toBeVisible({ timeout: 5_000 })

  // Close the drawer.
  const closeBtn = alice.getByRole("button", { name: /Close history/i }).first()
  await closeBtn.click()
  await expect(alice.getByText(/Edit history/i).first()).not.toBeVisible({ timeout: 3_000 })
})
