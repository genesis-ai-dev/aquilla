import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * CellActionRail direct "Add comment" button opens CommentsDrawer.
 */
test("rail Add comment button opens the comments drawer", async ({ alice }) => {
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

  const addCommentBtn = row.locator('button[aria-label="Add comment"]').first()
  await expect(addCommentBtn).toBeVisible({ timeout: 8_000 })
  await addCommentBtn.click()

  // CommentsDrawer should open.
  const drawer = alice.locator('[data-testid="comments-drawer"]')
  await expect(drawer).toBeVisible({ timeout: 8_000 })
})
