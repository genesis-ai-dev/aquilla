import { test, expect } from "../../helpers/multi-user"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"

/**
 * CommentsPage — "Show resolved" checkbox filter.
 *
 * CommentsPage.tsx has a "Show resolved" checkbox (type="checkbox") next to
 * the filter controls. When unchecked (default), resolved threads are hidden.
 * Checking it makes resolved threads visible again.
 *
 * This spec: post a comment → resolve it → navigate to /comments →
 * verify comment is hidden → check "Show resolved" → comment appears.
 */
test("comments page Show resolved checkbox reveals resolved threads", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `ShowResolved ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await row.hover()
  const addCommentBtn = row.locator('button[aria-label="Add comment"]')
  await expect(addCommentBtn).toBeVisible({ timeout: 5_000 })
  await addCommentBtn.click()

  // Post a comment.
  const commentText = `resolved-comment-${Date.now()}`
  const textarea = alice.locator("textarea").first()
  await textarea.waitFor({ state: "visible", timeout: 5_000 })
  await textarea.fill(commentText)
  const postBtn = alice.getByRole("button", { name: /post|submit|send/i }).first()
  await expect(postBtn).toBeEnabled({ timeout: 3_000 })
  await postBtn.click()
  await expect(alice.getByText(commentText)).toBeVisible({ timeout: 5_000 })

  // Resolve the comment.
  const resolveBtn = alice.getByRole("button", { name: /^Resolve$/i })
  await expect(resolveBtn).toBeVisible({ timeout: 5_000 })
  await resolveBtn.click()
  // After resolving, Reopen button appears.
  await expect(alice.getByRole("button", { name: /Reopen/i })).toBeVisible({ timeout: 5_000 })

  // Navigate to the comments page.
  const projectId = alice.url().match(/\/project\/([^/?]+)/)?.[1]
  expect(projectId).toBeTruthy()
  await alice.goto(`/project/${projectId}/comments`)
  // The "Show resolved" toggle lives inside the collapsed "Filters" panel.
  await alice.getByRole("button", { name: /^Filters$/i }).click()

  // "Show resolved" — label wraps the shadcn Checkbox (role="checkbox")
  // and a <span>Show resolved</span>. Unchecked by default: resolved
  // threads are hidden.
  const showResolvedCheckbox = alice.locator('label').filter({ hasText: /Show resolved/i }).getByRole("checkbox")
  await expect(showResolvedCheckbox).toBeVisible({ timeout: 5_000 })
  await expect(showResolvedCheckbox).not.toBeChecked()

  // Reveal resolved threads, then poll via the Refresh button: the page
  // fetches the server projection once on mount, and the drawer write
  // flushes via the client outbox which may land after page load.
  //
  // A resolved thread renders as a COLLAPSED card (CommentsPage CommentThread:
  // useState(!root.resolved)) — the body text sits inside the closed
  // Collapsible, so the card is detected via its header (Reopen button).
  const reopenBtn = alice.getByRole("button", { name: /^Reopen$/i }).first()
  await showResolvedCheckbox.check()
  await expect(async () => {
    await alice.getByRole("button", { name: /^Refresh$/i }).click()
    await expect(reopenBtn).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 15_000 })

  // Expand the collapsed thread (the chevron CollapsibleTrigger is the icon
  // button right after Reopen in the card header) — the body becomes visible.
  await reopenBtn.locator("..").getByRole("button").last().click()
  await expect(alice.getByText(commentText)).toBeVisible({ timeout: 5_000 })

  // Uncheck — the resolved thread is hidden again (the default state).
  await showResolvedCheckbox.uncheck()
  await expect(reopenBtn).not.toBeVisible({ timeout: 5_000 })

  // Re-check — the resolved thread is revealed.
  await showResolvedCheckbox.check()
  await expect(reopenBtn).toBeVisible({ timeout: 5_000 })
})
