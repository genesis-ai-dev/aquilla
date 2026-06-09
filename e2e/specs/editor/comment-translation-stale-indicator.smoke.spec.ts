import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * CommentThread — "Translation changed since this thread was created" indicator.
 *
 * CommentThread.tsx line 31:
 *   const isStale = thread.createdForTranslated !== currentTranslated
 *
 * When a comment is added to a cell with an empty translation
 * (createdForTranslated = ""), and the cell is subsequently translated,
 * the amber AlertTriangle span appears:
 *   <span title="Translation changed since this thread was created">
 *
 * Flow:
 *   1. Import a file — cells start with empty translations.
 *   2. Open cell 0 (no translation yet).
 *   3. Add a comment thread on cell 0 (createdForTranslated = "").
 *   4. Close the drawer.
 *   5. Edit cell 0 to add a translation (now currentTranslated ≠ "").
 *   6. Re-open the CommentsDrawer for cell 0.
 *   7. The amber "Translation changed since this thread was created" indicator
 *      is visible on the thread.
 */
test("comment stale indicator appears when translation changes after thread was created", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `StaleComment ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Step 1: Add a comment when cell 0 has no translation yet.
  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await row.hover()

  const moreBtn = row.locator('button[aria-label="More cell actions"]')
  await expect(moreBtn).toBeVisible({ timeout: 5_000 })
  await moreBtn.click()

  const addCommentBtn = alice.getByRole("menuitem", { name: /add comment/i })
    .or(alice.getByRole("button", { name: /add comment/i }))
  await expect(addCommentBtn.first()).toBeVisible({ timeout: 5_000 })
  await addCommentBtn.first().click()

  const drawer = alice.locator("[data-testid='comments-drawer']").first()
  await expect(drawer).toBeVisible({ timeout: 5_000 })

  // Post a comment thread (cell translation is empty at this point).
  const commentText = `stale-test-${Date.now()}`
  const textarea = drawer.locator("textarea").first()
  await textarea.fill(commentText)
  await drawer.getByRole("button", { name: /post|submit|send/i }).first().click()
  await expect(drawer).toContainText(commentText, { timeout: 8_000 })

  // Step 2: Close the drawer.
  const closeBtn = drawer.getByRole("button", { name: /close/i }).first()
    .or(alice.locator('button[aria-label="Close"]').first())
  if (await closeBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await closeBtn.click()
  } else {
    await alice.keyboard.press("Escape")
  }
  await expect(drawer).not.toBeVisible({ timeout: 3_000 })

  // Step 3: Edit cell 0 to add a translation (now currentTranslated ≠ "").
  await ws.editCell(0, "traduction de test pour indicateur stale")

  // Step 4: Re-open the CommentsDrawer for cell 0.
  await row.hover()
  await moreBtn.click()
  await addCommentBtn.first().click()
  const drawer2 = alice.locator("[data-testid='comments-drawer']").first()
  await expect(drawer2).toBeVisible({ timeout: 5_000 })
  await expect(drawer2).toContainText(commentText, { timeout: 5_000 })

  // Step 5: The stale indicator should be visible on the thread.
  const staleIndicator = drawer2.locator('[title="Translation changed since this thread was created"]')
  await expect(staleIndicator).toBeVisible({ timeout: 5_000 })
})
