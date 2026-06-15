import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * SKIPPED — UI path removed. CellActionsMenu (per-cell "More actions" ⋯
 * popover) is no longer mounted anywhere: commit 64a2d2f62 ("feat: add
 * CellActionRail and CellExpansion components with tabs") replaced it with
 * the CellActionRail + CellExpansion panel. The component file
 * (src/components/CellActionsMenu.tsx) still exists but has zero call sites
 * — dead code.
 *
 * The history-drawer journey this spec covered now lives at:
 *   cell row → "Open cell details" chevron → History tab → "Open full history"
 * which is exactly what cell-history-drawer.smoke.spec.ts already exercises.
 * Keeping this spec would duplicate that coverage against a UI that no
 * longer exists, so it is skipped pending deletion (and CellActionsMenu.tsx
 * cleanup).
 */
test.skip("More actions menu History item opens the history drawer", async ({ alice }) => {
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
  const moreBtn = row.locator('button[aria-label="More actions"]').first()
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
