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

  const addCommentBtn = row.locator('button[aria-label="Add comment"]')
  await expect(addCommentBtn).toBeVisible({ timeout: 5_000 })
  await addCommentBtn.click()

  const drawer = alice.locator("[data-testid='comments-drawer']").first()
  await expect(drawer).toBeVisible({ timeout: 5_000 })

  // Post a comment thread (cell translation is empty at this point).
  const commentText = `stale-test-${Date.now()}`
  const textarea = drawer.locator("textarea").first()
  await textarea.fill(commentText)
  await drawer.getByRole("button", { name: /post|submit|send/i }).first().click()
  await expect(drawer).toContainText(commentText, { timeout: 8_000 })

  // Step 2: Close the drawer. The header close button is icon-only (no
  // accessible name), and /close/i would match the thread's disabled
  // "Close with reply" button instead — so target the first button in the
  // drawer, which is the header X.
  await drawer.getByRole("button").first().click()
  await expect(drawer).not.toBeVisible({ timeout: 3_000 })

  // Step 3: Edit cell 0 to add a translation (now currentTranslated ≠ "").
  await ws.editCell(0, "traduction de test pour indicateur stale")

  // Step 4: Re-open the CommentsDrawer for cell 0. Once the cell carries a
  // comment, the rail button is relabelled "1 open comment" and the AQU-599
  // gutter chip ("1 open comment — open comments") appears — the original
  // "Add comment" label no longer exists. Click the always-visible chip.
  await row.hover()
  await row.locator('button[aria-label$="open comments"]').click()
  const drawer2 = alice.locator("[data-testid='comments-drawer']").first()
  await expect(drawer2).toBeVisible({ timeout: 5_000 })
  await expect(drawer2).toContainText(commentText, { timeout: 5_000 })

  // Step 5: The stale indicator should be visible on the thread.
  const staleIndicator = drawer2.getByText("stale", { exact: true })
  await expect(staleIndicator).toBeVisible({ timeout: 5_000 })
})
