import { test, expect } from "../../helpers/multi-user"
import { pickSelectOption, expectSelectValue } from "../../helpers/base-ui"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * CommentsPage — "Filters" button expands/collapses the filter panel.
 *
 * CommentsPage.tsx has a "Filters" button (<SlidersHorizontal> icon)
 * that toggles an expanded filter panel containing:
 *   - Sort picker (select with options: Unresolved first / Most recent activity / Newest first)
 *   - "Show resolved" checkbox
 *   - File filter select
 *
 * This spec: navigate to /comments → click "Filters" button →
 * filter panel expands showing the Sort select → change sort to "Newest first" →
 * verify select value → click "Filters" again → panel collapses.
 */
test("comments Filters button expands filter panel and sort picker works", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `CommentsFilters ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  // Post a comment so the comments page has content.
  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await row.hover()
  const addCommentBtn = row.locator('button[aria-label="Add comment"]')
  await expect(addCommentBtn).toBeVisible({ timeout: 5_000 })
  await addCommentBtn.click()
  const commentInput = alice.locator("textarea").first()
  await commentInput.waitFor({ state: "visible", timeout: 5_000 })
  await commentInput.fill(`filter-test-${Date.now()}`)
  const postBtn = alice.getByRole("button", { name: /post|submit|send/i }).first()
  await expect(postBtn).toBeEnabled({ timeout: 3_000 })
  await postBtn.click()

  // Navigate to /comments page.
  const projectUrl = alice.url()
  const match = projectUrl.match(/\/project\/([^/]+)/)
  const projectId = match ? match[1] : ""
  await alice.goto(`/project/${projectId}/comments`)
  // The "Filters" button should be visible.
  const filtersBtn = alice.getByRole("button", { name: /^Filters$/i })
  await expect(filtersBtn).toBeVisible({ timeout: 10_000 })

  // The sort select (Base UI combobox trigger) should NOT be visible yet (collapsed).
  const sortTrigger = alice
    .locator("label")
    .filter({ has: alice.locator("span", { hasText: /^Sort$/ }) })
    .getByRole("combobox")
  await expect(sortTrigger).not.toBeVisible()

  // Click "Filters" to expand.
  await filtersBtn.click()

  // Sort select appears with the default "Unresolved first" label.
  await expect(sortTrigger).toBeVisible({ timeout: 3_000 })
  await expectSelectValue(sortTrigger, "Unresolved first")

  // Change sort to "Newest first".
  await pickSelectOption(alice, sortTrigger, "Newest first")
  await expectSelectValue(sortTrigger, "Newest first")

  // Click "Filters" again to collapse.
  await filtersBtn.click()
  await expect(sortTrigger).not.toBeVisible({ timeout: 2_000 })
})
