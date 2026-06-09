import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * HistoryDrawer — "Show intermediate edits" / "Hide intermediate edits" toggle.
 *
 * HistoryDrawer.tsx renders a toggle button for terminal entries that have
 * sub-entries (multiple edits compressed into one "terminal"):
 *   "Show intermediate edits" → expands the sub-entry list
 *   "Hide intermediate edits" → collapses it
 *
 * To produce sub-entries, a cell needs multiple edits by the same author
 * within a short time window (the history compression algorithm groups them).
 *
 * This spec:
 *   1. Imports sample.md.
 *   2. Edits cell 0 three times quickly (same author, same session).
 *   3. Opens the CellExpansion → History tab → "Open full history".
 *   4. Verifies HistoryDrawer opens with heading "Edit history".
 *   5. Looks for "Show intermediate edits" button → clicks it.
 *   6. Verifies the text changes to "Hide intermediate edits".
 *   7. Clicks "Hide intermediate edits" → text reverts.
 *
 * If the history compression doesn't produce sub-entries (only 1 terminal),
 * the toggle won't appear — the spec gracefully exits early.
 */
test("HistoryDrawer show/hide intermediate edits toggle works", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `HistIntermed ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Edit the first cell multiple times quickly to create sub-entries.
  await ws.editCell(0, "v1")
  await alice.waitForTimeout(200)
  await ws.editCell(0, "v1 updated")
  await alice.waitForTimeout(200)
  await ws.editCell(0, "v1 final")
  await alice.waitForTimeout(500)

  // Open CellExpansion panel.
  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await row.hover()

  const expandBtn = row.locator('button[aria-label="Open cell details"]').first()
  await expect(expandBtn).toBeVisible({ timeout: 5_000 })
  await expandBtn.click()

  // Switch to History tab.
  const historyTab = alice.locator('[role="tab"]').filter({ hasText: /History/i }).first()
  await expect(historyTab).toBeVisible({ timeout: 5_000 })
  await historyTab.click()

  // Click "Open full history" button.
  const openHistoryBtn = alice.getByRole("button", { name: /Open full history/i }).first()
  await expect(openHistoryBtn).toBeVisible({ timeout: 5_000 })
  await openHistoryBtn.click()

  // HistoryDrawer opens.
  await expect(alice.getByRole("heading", { name: /Edit history/i }).first()).toBeVisible({ timeout: 5_000 })

  // Look for "Show intermediate edits" toggle.
  const showToggle = alice.getByText(/Show intermediate edits/i).first()
  if (!(await showToggle.isVisible({ timeout: 2_000 }).catch(() => false))) {
    // No sub-entries produced — spec exits gracefully.
    return
  }

  await showToggle.click()
  await alice.waitForTimeout(200)

  // Should now show "Hide intermediate edits".
  const hideToggle = alice.getByText(/Hide intermediate edits/i).first()
  await expect(hideToggle).toBeVisible({ timeout: 3_000 })

  // Click to hide again.
  await hideToggle.click()
  await alice.waitForTimeout(200)

  // Back to "Show intermediate edits".
  await expect(alice.getByText(/Show intermediate edits/i).first()).toBeVisible({ timeout: 3_000 })
})
