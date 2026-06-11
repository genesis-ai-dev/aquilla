import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Comment resolve + reopen workflow.
 *
 * CommentThread.tsx has:
 *   - "Resolve" button (variant ghost) — resolves without a reply message
 *   - After resolution the thread shows "Reopen" (variant ghost)
 *
 * This spec: post a comment → click Resolve → thread shows resolved state
 * (Reopen button visible) → click Reopen → Resolve button returns.
 */
test("comment resolve and reopen workflow", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `CommentResolve ${Date.now()}`
  await dash.createProject({ name })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Open comments drawer for the first cell.
  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await row.hover()

  const addCommentBtn = row.locator('button[aria-label="Add comment"]')
  await expect(addCommentBtn).toBeVisible({ timeout: 5_000 })
  await addCommentBtn.click()

  const drawer = alice.locator("[data-testid='comments-drawer']").first()
  await expect(drawer).toBeVisible({ timeout: 5_000 })

  // Post a comment.
  const commentText = `resolve-test-${Date.now()}`
  const textarea = drawer.locator("textarea").first()
  await textarea.waitFor({ state: "visible", timeout: 5_000 })
  await textarea.fill(commentText)
  const postBtn = drawer.getByRole("button", { name: /post|submit|send/i }).first()
  await expect(postBtn).toBeVisible({ timeout: 3_000 })
  await postBtn.click()
  await expect(drawer).toContainText(commentText, { timeout: 8_000 })

  // Resolve the comment.
  const resolveBtn = drawer.getByRole("button", { name: /^Resolve$/i })
  await expect(resolveBtn).toBeVisible({ timeout: 5_000 })
  await resolveBtn.click()

  // Thread is now resolved — "Reopen" button appears.
  const reopenBtn = drawer.getByRole("button", { name: /Reopen/i })
  await expect(reopenBtn).toBeVisible({ timeout: 5_000 })

  // Reopen the thread — "Resolve" returns.
  await reopenBtn.click()
  await expect(resolveBtn).toBeVisible({ timeout: 5_000 })
})
