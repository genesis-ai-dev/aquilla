import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * EditorTable "More cell actions" popover — Add comment path.
 *
 * EditorTable.tsx (around line 2515) renders a Popover per cell in the
 * CellActionRail. The trigger button has:
 *   aria-label="More cell actions"
 *   title="More actions"
 *
 * The popover is visible when the cell has translated text, audio, or comments.
 * After editing a cell we get translated text → the popover trigger appears.
 * The popover contains an "Add comment" button (or open comment count).
 *
 * This is distinct from CellActionsMenu (the three-dot overflow in the
 * CellActionRail) and CellActionRail's dedicated comment button.
 *
 * Steps:
 *   1. Import sample.md → edit first cell with text.
 *   2. Hover the row to reveal CellActionRail.
 *   3. Click "More cell actions" popover trigger.
 *   4. Popover opens → "Add comment" button appears.
 *   5. Click it → CommentsDrawer opens.
 */
test("'More cell actions' popover Add comment opens CommentsDrawer", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `MoreCellAct ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Edit first cell so it has translated text (required to show the popover trigger).
  await ws.editCell(0, "bonjour monde")

  // Hover the first row to reveal CellActionRail buttons.
  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await row.hover()

  // The "More cell actions" button.
  const moreCellBtn = row.locator('button[aria-label="More cell actions"]').first()
  await expect(moreCellBtn).toBeVisible({ timeout: 8_000 })
  await moreCellBtn.click()

  // Popover opens containing an "Add comment" or comment-count button.
  const addCommentBtn = alice.getByText(/Add comment/i).first()
  await expect(addCommentBtn).toBeVisible({ timeout: 5_000 })
  await addCommentBtn.click()

  // CommentsDrawer (data-testid="comments-drawer") should open.
  const drawer = alice.locator('[data-testid="comments-drawer"]')
  await expect(drawer).toBeVisible({ timeout: 8_000 })
})
