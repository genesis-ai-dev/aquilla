import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Cell expansion panel — History tab → "Open full history" drawer.
 *
 * Each cell row has a CellActionRail expand chevron button
 * (aria-label="Open cell details"). Clicking it opens CellExpansion with
 * multiple tabs. The "History" tab shows recent edit history; when there
 * are entries a button "Open full history" appears and opens the
 * full-page HistoryDrawer (heading "Edit history").
 *
 * This spec: import a file → edit a cell → expand the cell → switch to
 * History tab → assert "Open full history" button appears → click it →
 * assert HistoryDrawer heading "Edit history" is visible → close drawer.
 */
test("cell expansion History tab opens full HistoryDrawer", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `CellHist ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()

  // Edit the cell so there's at least one history entry.
  const editable = row.locator('textarea, [contenteditable="true"]').first()
  await editable.waitFor({ state: "visible", timeout: 10_000 })
  await editable.click()
  await alice.keyboard.press("End")
  await alice.keyboard.insertText(" hist-test")
  // Click away to commit.
  await alice.locator("aside, header").first().click()

  // Hover to reveal CellActionRail.
  await row.hover()

  // Open cell details (expand chevron).
  const expandBtn = row.getByRole("button", { name: /Open cell details/i })
  await expect(expandBtn).toBeVisible({ timeout: 5_000 })
  await expandBtn.click()

  // The expansion panel opens — switch to the History tab.
  const historyTab = alice.getByRole("button", { name: /^History$/i })
    .or(alice.getByRole("tab", { name: /^History$/i }))
  await expect(historyTab.first()).toBeVisible({ timeout: 5_000 })
  await historyTab.first().click()

  // "Open full history" button appears (requires at least one history entry).
  const openHistoryBtn = alice.getByRole("button", { name: /Open full history/i })
  await expect(openHistoryBtn).toBeVisible({ timeout: 8_000 })
  await openHistoryBtn.click()

  // HistoryDrawer opens — heading "Edit history" is visible.
  await expect(alice.getByText(/Edit history/i).first()).toBeVisible({ timeout: 5_000 })

  // Close the drawer.
  const closeBtn = alice.getByRole("button", { name: /Close/i }).first()
  await closeBtn.click()
  await expect(alice.getByText(/Edit history/i).first()).not.toBeVisible({ timeout: 3_000 })
})
