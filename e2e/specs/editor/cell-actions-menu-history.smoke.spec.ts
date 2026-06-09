import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * CellActionsMenu — "More actions" → "History (N)" opens the history drawer.
 *
 * CellActionsMenu.tsx renders a Popover triggered by a button
 *   aria-label="More actions" (title="More actions")
 * visible on each cell row when there are visible items.
 *
 * The "History (N)" item appears when `historyCount > 0` — i.e. the cell
 * has been edited at least once. Clicking it calls `onOpenHistory(cellId)`.
 *
 * This spec is distinct from cell-history-drawer.smoke.spec.ts, which opens
 * history via the CellExpansion panel's History tab. This spec exercises the
 * CellActionsMenu "More actions" → "History" path.
 *
 * Steps:
 *   1. Import sample.md.
 *   2. Edit the first cell (creates ≥1 history entry).
 *   3. Hover the first cell row to reveal the "More actions" button.
 *   4. Click "More actions" to open the popover.
 *   5. Click "History (1)" menu item.
 *   6. Verify the HistoryDrawer heading "Edit history" appears.
 */
test("More actions menu History item opens the history drawer", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `CellActHist ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Edit the first cell to create a history entry.
  await ws.editCell(0, "translated text")

  // Hover the first row to reveal row actions.
  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await row.hover()

  // Click the "More actions" button (CellActionsMenu trigger).
  const moreBtn = row.locator('button[aria-label="More actions"], button[title="More actions"]').first()
  await expect(moreBtn).toBeVisible({ timeout: 8_000 })
  await moreBtn.click()

  // The popover opens with menu items.
  // Look for the "History" menuitem (label starts with "History").
  const historyItem = alice.locator('[role="menuitem"]').filter({ hasText: /^History/i }).first()
  await expect(historyItem).toBeVisible({ timeout: 5_000 })
  await historyItem.click()

  // HistoryDrawer should open with heading "Edit history".
  const drawer = alice.getByRole("heading", { name: /Edit history/i }).first()
  await expect(drawer).toBeVisible({ timeout: 8_000 })
})
