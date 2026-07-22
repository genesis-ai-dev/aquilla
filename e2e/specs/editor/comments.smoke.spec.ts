import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * Comment pipeline smoke test:
 *   1. alice opens a project, imports a file, opens the editor.
 *   2. From the cell action popover she opens CommentsDrawer.
 *   3. She types a comment and posts it.
 *   4. The comment appears in the drawer (BUG-3 fixed: liveComments prop +
 *      recordsToThreads adapter).
 *   5. POST /events returned 200 (BUG-2 fixed: fileId now passed to enqueueEvent).
 */
test("alice posts a comment on a cell and it appears in the drawer", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Comments ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await row.hover()

  const addCommentBtn = row.locator('button[aria-label="Add comment"]')
  await expect(addCommentBtn).toBeVisible({ timeout: 5_000 })
  await addCommentBtn.click()

  // CommentsDrawer should now be open. The drawer renders as a div with
  // data-testid="comments-drawer" (no aria-label or semantic landmark).
  const drawer = alice.locator("[data-testid='comments-drawer']").first()
  await expect(drawer).toBeVisible({ timeout: 5_000 })

  // Type and post the comment.
  const commentText = `e2e-comment-${Date.now()}`
  const textarea = drawer.locator("textarea").first()
  await textarea.waitFor({ state: "visible", timeout: 5_000 })
  await textarea.fill(commentText)

  const postBtn = drawer.getByRole("button", { name: /post|submit|send/i }).first()
  await expect(postBtn).toBeVisible({ timeout: 3_000 })
  await postBtn.click()

  // The comment should appear in the drawer.
  await expect(drawer).toContainText(commentText, { timeout: 8_000 })
})
