import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

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
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `ShowResolved ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

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
  await alice.waitForLoadState("networkidle")

  // The resolved comment should be hidden by default.
  await expect(alice.getByText(commentText)).not.toBeVisible({ timeout: 5_000 })

  // The "Show resolved" toggle lives inside the collapsed "Filters" panel.
  await alice.getByRole("button", { name: /Filters/i }).click()

  // Check "Show resolved" — label wraps the shadcn Checkbox (role="checkbox")
  // and a <span>Show resolved</span>.
  const showResolvedCheckbox = alice.locator('label').filter({ hasText: /Show resolved/i }).getByRole("checkbox")
  await expect(showResolvedCheckbox).toBeVisible({ timeout: 5_000 })
  await showResolvedCheckbox.check()

  // The resolved comment is now visible.
  await expect(alice.getByText(commentText)).toBeVisible({ timeout: 5_000 })
})
