import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * CommentThread — submit comment via Ctrl+Enter keyboard shortcut.
 *
 * CommentThread.tsx fires `handleSubmit` when the user presses
 * Ctrl+Enter (or Cmd+Enter on Mac) inside the comment textarea:
 *
 *   if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
 *     e.preventDefault()
 *     handleSubmit()
 *   }
 *
 * This spec:
 *   1. Opens the comments drawer for the first cell.
 *   2. Types a comment into the textarea.
 *   3. Presses Ctrl+Enter instead of clicking the post button.
 *   4. Verifies the comment appears in the drawer.
 *
 * This is a distinct code path from the button-click submission tested in
 * comments.smoke.spec.ts.
 */
test("comment submitted via Ctrl+Enter keyboard shortcut", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `CommentKb ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Open comments for the first cell row.
  const row = ws.cellRow(0)
  await row.hover()
  const commentBtn = row.locator('[aria-label="Add comment"]')
    .or(row.locator('[data-tooltip="Add comment"]'))
  await expect(commentBtn.first()).toBeVisible({ timeout: 5_000 })
  await commentBtn.first().click()

  // CommentsDrawer should open.
  // Keep this locator anchored to the drawer itself. Once the comment is
  // created, the row also gains an "open comments" button; a broad union can
  // then start resolving to that earlier DOM node instead of the drawer.
  const drawer = alice.locator('[data-testid="comments-drawer"]')
  await expect(drawer).toBeVisible({ timeout: 8_000 })

  // Type a unique comment text.
  const commentText = `kb-submit-${Date.now()}`
  const textarea = drawer.locator("textarea").first()
  await expect(textarea).toBeVisible({ timeout: 5_000 })
  await textarea.fill(commentText)

  // Press Ctrl+Enter to submit (instead of clicking the post button).
  await alice.keyboard.press("Control+Enter")

  // The comment text should appear in the drawer.
  await expect(drawer).toContainText(commentText, { timeout: 8_000 })
})
