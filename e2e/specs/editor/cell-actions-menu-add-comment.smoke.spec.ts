import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * CellActionsMenu — "More actions" → "Add comment" opens comments drawer.
 *
 * CellActionsMenu.tsx renders "Add comment" as the first menu item when
 * `onAddComment` is wired (it always is in ProjectWorkspace). Clicking it
 * calls `onAddComment(cellId)`, which opens the CommentsDrawer.
 *
 * This tests the specific "More actions" → "Add comment" click path —
 * distinct from the direct comment button on the row rail (if present).
 *
 * Steps:
 *   1. Import sample.md.
 *   2. Hover first row → click "More actions".
 *   3. Click "Add comment" in the popover.
 *   4. Verify CommentsDrawer (data-testid="comments-drawer") opens.
 */
test("More actions menu Add comment opens the comments drawer", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `CellActComment ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Hover the first row to reveal row actions.
  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await row.hover()

  // Click the "More actions" button (CellActionsMenu trigger).
  const moreBtn = row.locator('button[aria-label="More actions"], button[title="More actions"]').first()
  await expect(moreBtn).toBeVisible({ timeout: 8_000 })
  await moreBtn.click()

  // Click "Add comment" in the popover menu.
  const addCommentItem = alice.locator('[role="menuitem"]').filter({ hasText: /Add comment/i }).first()
  await expect(addCommentItem).toBeVisible({ timeout: 5_000 })
  await addCommentItem.click()

  // CommentsDrawer should open.
  const drawer = alice.locator('[data-testid="comments-drawer"]')
  await expect(drawer).toBeVisible({ timeout: 8_000 })
})
