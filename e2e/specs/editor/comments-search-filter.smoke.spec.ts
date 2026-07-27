import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * CommentsPage — "Search comments…" search box filters threads.
 *
 * FilterControls (inside CommentsPage) has a search Input with
 * placeholder="Search comments…". Typing narrows the displayed comment
 * threads. When the search is non-empty, an "active filter count" badge
 * (e.g. "1 filter") appears in the header.
 *
 * When no threads match the search, a "No threads match your filters"
 * message and a "Clear filters" button appear.
 *
 * This spec: post a comment → navigate to /comments → type a unique
 * matching search string → verify the comment is still visible →
 * type a non-matching string → verify "No threads match" message +
 * "Clear filters" button → click Clear filters → search input clears.
 */
test("comments page search box filters threads and clear filters resets", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `CommentsSearch ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Post a comment on the first cell.
  const row = ws.cellRow(0)
  await row.hover()
  const commentBtn = row.locator('[aria-label="Add comment"]').or(
    row.locator('[data-tooltip="Add comment"]')
  )
  await expect(commentBtn.first()).toBeVisible({ timeout: 5_000 })
  await commentBtn.first().click()

  const uniqueText = `unique-search-token-${Date.now()}`
  const commentInput = alice.locator('textarea[placeholder*="comment"]').or(
    alice.locator('textarea[placeholder*="Add a comment"]')
  )
  await expect(commentInput.first()).toBeVisible({ timeout: 5_000 })
  await commentInput.first().fill(uniqueText)
  await alice.keyboard.press("Control+Enter")

  // Confirm the comment was posted before leaving the editor.
  const drawer = alice.locator("[data-testid='comments-drawer']").first()
  await expect(drawer).toContainText(uniqueText, { timeout: 8_000 })

  // Navigate to /comments page. With a file open the URL is
  // /project/:id/editor/file/:fileId, so extract the project id directly.
  const projectId = alice.url().match(/\/project\/([^/?#]+)/)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/comments`)
  // The posted comment should be visible. The page fetches the server
  // projection once on mount, and the drawer write flushes via the client
  // outbox which may land after page load — poll via the Refresh button.
  await expect(async () => {
    await alice.getByRole("button", { name: /^Refresh$/i }).click()
    await expect(alice.getByText(uniqueText)).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 15_000 })

  // With no filter active, the header count badge shows the total (1 here).
  const countBadge = alice.getByTestId("comments-count-badge")
  await expect(countBadge).toHaveText("1", { timeout: 3_000 })

  // Search for matching text.
  const searchInput = alice.locator('input[placeholder="Search comments…"]')
  await expect(searchInput).toBeVisible({ timeout: 5_000 })
  await searchInput.fill(uniqueText)

  // Comment is still visible, and filter badge appears.
  await expect(alice.getByText(uniqueText)).toBeVisible({ timeout: 3_000 })
  await expect(alice.getByText(/1 filter/i)).toBeVisible({ timeout: 3_000 })
  // AQU-650: with a filter active that leaves 1 visible thread, the count
  // badge reflects the filtered thread count (still 1 here).
  await expect(countBadge).toHaveText("1", { timeout: 3_000 })

  // Type a non-matching query.
  await searchInput.fill("zzz-no-match-zzz")

  // "No threads match your filters" and "Clear filters" button appear.
  await expect(alice.getByText(/No threads match your filters/i)).toBeVisible({ timeout: 5_000 })
  // AQU-650: the count badge shows 0 when filters match nothing — it must not
  // fall back to the project total (which was the pre-fix bug: it showed 1).
  await expect(countBadge).toHaveText("0", { timeout: 3_000 })
  const clearBtn = alice.getByRole("button", { name: /Clear filters/i })
  await expect(clearBtn).toBeVisible({ timeout: 2_000 })

  // Click Clear filters — search input is emptied.
  await clearBtn.click()
  await expect(searchInput).toHaveValue("", { timeout: 3_000 })
  await expect(alice.getByText(uniqueText)).toBeVisible({ timeout: 3_000 })
  // AQU-650: clearing filters returns the badge to the total.
  await expect(countBadge).toHaveText("1", { timeout: 3_000 })
})
