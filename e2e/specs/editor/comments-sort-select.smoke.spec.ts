import { test, expect } from "../../helpers/multi-user"
import { pickSelectOption, expectSelectValue } from "../../helpers/base-ui"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * CommentsPage — "Sort" select changes sort order.
 *
 * CommentsPage.tsx renders a <select> labeled "Sort" with options:
 *   - "unresolved-first" (default)
 *   - "recent-activity"
 *   - "creation"
 *
 * This spec: post a comment → navigate to /comments → find the Sort select
 * → verify default is "unresolved-first" → change to "recent-activity" →
 * verify value changes → change to "creation" → verify value changes.
 */
test("comments page sort select changes sort order", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `CommentSort ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Post a comment so the comments page has content.
  const row = ws.cellRow(0)
  await row.hover()
  const commentBtn = row.getByRole("button", { name: /Add comment/i }).first()
  await expect(commentBtn).toBeVisible({ timeout: 10_000 })
  await commentBtn.click()

  // Post via the CommentsDrawer.
  const drawer = alice.locator('[data-testid="comments-drawer"]')
  await expect(drawer).toBeVisible({ timeout: 10_000 })
  const textarea = drawer.locator('textarea[placeholder*="comment" i], textarea[placeholder*="Comment" i]').first()
  await expect(textarea).toBeVisible()
  await textarea.fill("sort-test-comment")
  await drawer.locator('button[type="submit"], button:has-text("Post")').first().click()
  await expect(drawer.getByText("sort-test-comment")).toBeVisible({ timeout: 10_000 })

  // Navigate to /comments page for the project.
  await alice.waitForURL(/\/project\/([^/]+)\//, { timeout: 5_000 })
  const projectId = alice.url().match(/\/project\/([^/]+)\//)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/comments`)
  // The Sort control lives inside the collapsed "Filters" panel — expand it.
  const filtersBtn = alice.getByRole("button", { name: /^Filters$/i })
  await expect(filtersBtn).toBeVisible({ timeout: 10_000 })
  await filtersBtn.click()

  // Find the "Sort" select — it's in a label with text "Sort".
  // The Base UI combobox trigger is a sibling of the "Sort" text span.
  const sortLabel = alice.locator('label').filter({ has: alice.locator('span', { hasText: /^Sort$/ }) })
  await expect(sortLabel).toBeVisible({ timeout: 10_000 })

  const sortTrigger = sortLabel.getByRole("combobox")
  await expect(sortTrigger).toBeVisible({ timeout: 3_000 })
  await expectSelectValue(sortTrigger, "Unresolved first")

  // Change to "Most recent activity".
  await pickSelectOption(alice, sortTrigger, "Most recent activity")
  await expectSelectValue(sortTrigger, "Most recent activity")

  // Change to "Newest first".
  await pickSelectOption(alice, sortTrigger, "Newest first")
  await expectSelectValue(sortTrigger, "Newest first")
})
