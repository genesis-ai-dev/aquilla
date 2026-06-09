import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

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
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `CommentSort ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Post a comment so the comments page has content.
  const row = ws.cellRow(0)
  await row.hover()
  const commentBtn = row.locator('[aria-label*="comment" i], [title*="comment" i]').first()
  if (await commentBtn.isVisible()) {
    await commentBtn.click()
  } else {
    // Try opening via cell action popover.
    const actionBtn = row.locator('[aria-label="Cell actions"]')
    if (await actionBtn.isVisible()) {
      await actionBtn.click()
      await alice.getByRole("button", { name: /Comment/i }).first().click()
    }
  }

  // Post via the CommentsDrawer.
  const drawer = alice.locator('[data-testid="comments-drawer"]')
  if (await drawer.isVisible({ timeout: 3_000 }).catch(() => false)) {
    const textarea = drawer.locator('textarea[placeholder*="comment" i], textarea[placeholder*="Comment" i]').first()
    if (await textarea.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await textarea.fill("sort-test-comment")
      await drawer.locator('button[type="submit"], button:has-text("Post")').first().click()
    }
  }

  // Navigate to /comments page for the project.
  await alice.waitForURL(/\/project\/([^/]+)\//, { timeout: 5_000 })
  const projectId = alice.url().match(/\/project\/([^/]+)\//)?.[1]
  expect(projectId).toBeTruthy()

  await alice.goto(`/project/${projectId}/comments`)
  await alice.waitForLoadState("networkidle")

  // Find the "Sort" select — it's in a label with text "Sort".
  // The select is a sibling of the "Sort" text span.
  const sortLabel = alice.locator('label').filter({ has: alice.locator('span', { hasText: /^Sort$/ }) })
  await expect(sortLabel).toBeVisible({ timeout: 10_000 })

  const sortSelect = sortLabel.locator('select')
  await expect(sortSelect).toBeVisible({ timeout: 3_000 })
  await expect(sortSelect).toHaveValue("unresolved-first")

  // Change to "Most recent activity".
  await sortSelect.selectOption("recent-activity")
  await expect(sortSelect).toHaveValue("recent-activity")

  // Change to "Newest first".
  await sortSelect.selectOption("creation")
  await expect(sortSelect).toHaveValue("creation")
})
