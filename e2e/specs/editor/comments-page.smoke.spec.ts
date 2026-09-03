import { test, expect } from "../../helpers/multi-user"
import { pickSelectOption, expectSelectValue } from "../../helpers/base-ui"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import {
  jwtFor,
  openSeededProject,
  seedProjectWithFile,
} from "../../helpers/seed-project"

/**
 * Surface session: CommentsPage empty state, filters, sort, search, back-nav,
 * and show-resolved. One `{ alice }` → one resetBackend(). Cell-level posting
 * contracts stay in comments.smoke.
 */

test("comments page empty state, filters, search, and resolved surface session", async ({
  alice,
}) => {
  test.setTimeout(180_000)

  await test.step("empty state for a new project (no Editor crumb)", async () => {
    const dash = new Dashboard(alice)
    await dash.goto()
    const name = `CommentsPage ${Date.now()}`
    await dash.createProject({ name, source: "en", target: "fr" })

    await alice.waitForURL(/\/projects\/[^/]+$/, { timeout: 5_000 })
    const projectId = alice.url().match(/\/projects\/([^/]+)$/)?.[1]
    expect(projectId).toBeTruthy()

    await alice.goto(`/project/${projectId}/comments`)
    await expect(
      alice.locator("h1").filter({ hasText: /Comments/i }),
    ).toBeVisible({ timeout: 10_000 })
    await expect(alice.getByText(/No comments yet/i)).toBeVisible({ timeout: 5_000 })

    const breadcrumb = alice.getByRole("navigation", { name: /breadcrumb/i })
    await expect(breadcrumb.getByText("Comments", { exact: true })).toBeVisible()
    await expect(breadcrumb.getByText("Editor", { exact: true })).toHaveCount(0)
  })

  const seeded = await seedProjectWithFile(await jwtFor(alice.username), {
    name: `CommentsPage ${Date.now()}`,
  })
  const ws = await openSeededProject(alice, seeded)
  const projectId = seeded.projectId

  const uniqueText = `unique-search-token-${Date.now()}`
  await test.step("post a comment then Filters expand, collapse, and sort", async () => {
    // AQU-200: comments live behind the rail's ⋯ overflow.
    const addCommentBtn = await ws.openRowAction(ws.cellRow(0), "Add comment")
    await addCommentBtn.click()

    const drawer = alice.locator('[data-testid="comments-drawer"]')
    await expect(drawer).toBeVisible({ timeout: 10_000 })
    const textarea = drawer
      .locator('textarea[placeholder*="comment" i], textarea[placeholder*="Comment" i]')
      .first()
    await expect(textarea).toBeVisible()
    await textarea.fill(uniqueText)
    await drawer.locator('button[type="submit"], button:has-text("Post")').first().click()
    await expect(drawer.getByText(uniqueText)).toBeVisible({ timeout: 10_000 })

    await alice.goto(`/project/${projectId}/comments`)
    await expect(async () => {
      await alice.getByRole("button", { name: /^Refresh$/i }).click()
      await expect(alice.getByText(uniqueText)).toBeVisible({ timeout: 1_000 })
    }).toPass({ timeout: 15_000 })

    const filtersBtn = alice.getByRole("button", { name: /^Filters$/i })
    await expect(filtersBtn).toBeVisible({ timeout: 10_000 })

    const sortTrigger = alice.getByRole("combobox", { name: /^Sort$/i })
    await expect(sortTrigger).not.toBeVisible()

    await filtersBtn.click()
    await expect(sortTrigger).toBeVisible({ timeout: 3_000 })
    await expectSelectValue(sortTrigger, "Unresolved first")

    await pickSelectOption(alice, sortTrigger, "Newest first")
    await expectSelectValue(sortTrigger, "Newest first")

    await pickSelectOption(alice, sortTrigger, "Most recent activity")
    await expectSelectValue(sortTrigger, "Most recent activity")

    await filtersBtn.click()
    await expect(sortTrigger).not.toBeVisible({ timeout: 2_000 })
  })

  await test.step("search box filters threads and Clear filters resets", async () => {
    // Still on /comments with uniqueText from prior step.
    const countBadge = alice.getByTestId("comments-count-badge")
    await expect(countBadge).toHaveText("1", { timeout: 3_000 })

    const searchInput = alice.locator('input[placeholder="Search comments…"]')
    await expect(searchInput).toBeVisible({ timeout: 5_000 })
    await searchInput.fill(uniqueText)

    await expect(alice.getByText(uniqueText)).toBeVisible({ timeout: 3_000 })
    await expect(alice.getByText(/1 filter/i)).toBeVisible({ timeout: 3_000 })
    await expect(countBadge).toHaveText("1", { timeout: 3_000 })

    await searchInput.fill("zzz-no-match-zzz")
    await expect(alice.getByText(/No threads match your filters/i)).toBeVisible({
      timeout: 5_000,
    })
    await expect(countBadge).toHaveText("0", { timeout: 3_000 })

    const clearBtn = alice.getByRole("button", { name: /Clear filters/i })
    await expect(clearBtn).toBeVisible({ timeout: 2_000 })
    await clearBtn.click()
    await expect(searchInput).toHaveValue("", { timeout: 3_000 })
    await expect(alice.getByText(uniqueText)).toBeVisible({ timeout: 3_000 })
    await expect(countBadge).toHaveText("1", { timeout: 3_000 })
  })

  await test.step("comments opened from editor shows Editor in the breadcrumb", async () => {
    await alice.goto(`/project/${projectId}/editor/file/${seeded.fileId}`)
    await ws.waitForEditor()

    await alice.locator("aside").getByRole("button", { name: /^Comments$/ }).click()
    await alice.waitForURL(/\/project\/[^/]+\/comments/, { timeout: 10_000 })
    await expect(
      alice.locator("h1").filter({ hasText: /Comments/i }),
    ).toBeVisible({ timeout: 10_000 })

    const breadcrumb = alice.getByRole("navigation", { name: /breadcrumb/i })
    const editorCrumb = breadcrumb.getByRole("link", { name: /^Editor$/i })
    await expect(editorCrumb).toBeVisible()
    await expect(breadcrumb.getByText("Comments", { exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    )

    await editorCrumb.click()
    await alice.waitForURL(/\/project\/[^/]+\/editor(?:\/file\/[^/]+)?/, { timeout: 10_000 })
    await ws.waitForEditor()
    await expect(alice.locator("h1").filter({ hasText: /Comments/i })).not.toBeVisible()
  })

  await test.step("Show resolved checkbox reveals resolved threads", async () => {
    // Cell 0 already has an open comment from earlier steps — use a fresh cell.
    // AQU-200: comments live behind the rail's ⋯ overflow.
    const addCommentBtn = await ws.openRowAction(ws.cellRow(2), "Add comment")
    await addCommentBtn.click()

    const commentText = `resolved-comment-${Date.now()}`
    const textarea = alice.locator("textarea").first()
    await textarea.waitFor({ state: "visible", timeout: 5_000 })
    await textarea.fill(commentText)
    const postBtn = alice.getByRole("button", { name: /post|submit|send/i }).first()
    await expect(postBtn).toBeEnabled({ timeout: 3_000 })
    await postBtn.click()
    await expect(alice.getByText(commentText)).toBeVisible({ timeout: 5_000 })

    const resolveBtn = alice.getByRole("button", { name: /^Resolve$/i })
    await expect(resolveBtn).toBeVisible({ timeout: 5_000 })
    await resolveBtn.click()
    await expect(alice.getByRole("button", { name: /Reopen/i })).toBeVisible({
      timeout: 5_000,
    })

    await alice.goto(`/project/${projectId}/comments`)
    await alice.getByRole("button", { name: /^Filters$/i }).click()

    const showResolvedSwitch = alice.getByRole("switch", { name: /Show resolved/i })
    await expect(showResolvedSwitch).toBeVisible({ timeout: 5_000 })
    await expect(showResolvedSwitch).not.toBeChecked()

    const reopenBtn = alice.getByRole("button", { name: /^Reopen$/i }).first()
    await showResolvedSwitch.click()
    await expect(async () => {
      await alice.getByRole("button", { name: /^Refresh$/i }).click()
      await expect(reopenBtn).toBeVisible({ timeout: 1_000 })
    }).toPass({ timeout: 15_000 })

    const chevron = reopenBtn.locator("..").getByRole("button").last()
    if (!(await alice.getByText(commentText).isVisible())) {
      await chevron.click()
    }
    await expect(alice.getByText(commentText)).toBeVisible({ timeout: 5_000 })

    await alice.getByRole("button", { name: /^Filters$/i }).click()
    await expect(showResolvedSwitch).toBeVisible({ timeout: 5_000 })
    await showResolvedSwitch.click()
    await expect(reopenBtn).not.toBeVisible({ timeout: 5_000 })

    await showResolvedSwitch.click()
    await expect(reopenBtn).toBeVisible({ timeout: 5_000 })
  })
})
