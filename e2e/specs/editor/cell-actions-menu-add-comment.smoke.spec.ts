import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * CellActionRail direct "Add comment" button opens CommentsDrawer.
 */
test("rail Add comment button opens the comments drawer", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `CellActComment ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

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
