import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * CommentsPage — "Go to cell" button navigates to the cell in editor.
 *
 * CommentsPage.tsx renders a "Go to cell" button (title="Go to cell in editor")
 * for each cell-scoped comment thread. Clicking it calls onNavigate(root)
 * which navigates to /project/:id/file/:fileId?cell=:cellId.
 *
 * Setup:
 *   1. Post a comment on cell 0 via the editor CommentsDrawer.
 *   2. Navigate to /project/:id/comments.
 *   3. Find the "Go to cell" button on the comment thread.
 *   4. Click it and verify the URL changes to /project/:id/file/:fileId.
 */
test("comments page Go to cell navigates to the cell in editor", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `GoToCell ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Post a comment on cell 0.
  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await row.hover()

  const moreBtn = row.locator("button[aria-label*='More'], button[title*='More'], button[aria-label*='action']").first()
  if (await moreBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await moreBtn.click()
  } else {
    await row.locator("button[aria-label*='comment'], button[title*='comment']").first().click()
  }

  const addCommentBtn = alice.getByRole("menuitem", { name: /add comment/i })
    .or(alice.getByRole("button", { name: /add comment/i }))
  await expect(addCommentBtn.first()).toBeVisible({ timeout: 5_000 })
  await addCommentBtn.first().click()

  const drawer = alice.locator("[data-testid='comments-drawer']").first()
  await expect(drawer).toBeVisible({ timeout: 5_000 })

  const commentText = `goto-cell-${Date.now()}`
  const textarea = drawer.locator("textarea").first()
  await textarea.waitFor({ state: "visible", timeout: 5_000 })
  await textarea.fill(commentText)

  const postBtn = drawer.getByRole("button", { name: /post|submit|send/i }).first()
  await expect(postBtn).toBeVisible({ timeout: 3_000 })
  await postBtn.click()

  // Confirm the comment was posted.
  await expect(drawer).toContainText(commentText, { timeout: 8_000 })

  // Capture current project ID.
  const projectId = alice.url().match(/\/project\/([^/?#]+)/)?.[1]
  expect(projectId).toBeTruthy()

  // Navigate to the comments page.
  await alice.goto(`/project/${projectId}/comments`)
  await alice.waitForLoadState("networkidle")

  await expect(alice.locator("h1").filter({ hasText: /Comments/i })).toBeVisible({
    timeout: 10_000,
  })

  // The comment thread should be visible.
  await expect(alice.getByText(commentText).first()).toBeVisible({ timeout: 10_000 })

  // Click "Go to cell" button on the thread.
  const goToCellBtn = alice.locator('button[title="Go to cell in editor"]')
    .or(alice.getByRole("button", { name: /Go to cell/i }))
    .first()
  await expect(goToCellBtn).toBeVisible({ timeout: 5_000 })
  await goToCellBtn.click()

  // URL should navigate to the file in the workspace editor.
  await alice.waitForURL(
    new RegExp(`/project/${projectId}/file/`),
    { timeout: 8_000 }
  )
})
