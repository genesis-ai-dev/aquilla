import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * CommentThread — reply to an existing comment.
 *
 * After posting the initial comment a CommentThread renders with:
 *   - The original comment text
 *   - A reply textarea (placeholder "Reply...")
 *   - A "Reply" button (Send icon, disabled until text is filled)
 *
 * Clicking "Reply" posts the reply and clears the input.
 *
 * This spec: post a comment → fill the Reply textarea → click Reply →
 * the reply text appears in the thread.
 */
test("CommentThread Reply button posts a reply", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `CommentReply ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Open cell action menu and add a comment.
  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await row.hover()
  const addCommentBtn = row.locator('button[aria-label="Add comment"]')
  await expect(addCommentBtn).toBeVisible({ timeout: 5_000 })
  await addCommentBtn.click()

  // Post initial comment.
  const commentInput = alice.locator("textarea").first()
  await commentInput.waitFor({ state: "visible", timeout: 5_000 })
  const initial = `initial-${Date.now()}`
  await commentInput.fill(initial)
  const postBtn = alice.getByRole("button", { name: /post|submit|send/i }).first()
  await expect(postBtn).toBeEnabled({ timeout: 3_000 })
  await postBtn.click()
  await expect(alice.getByText(initial)).toBeVisible({ timeout: 5_000 })

  // Now reply to the thread.
  const replyInput = alice.locator('textarea[placeholder="Reply..."]').first()
  await expect(replyInput).toBeVisible({ timeout: 5_000 })

  const replyText = `reply-${Date.now()}`
  await replyInput.fill(replyText)

  // Reply button (Send icon + "Reply" label) becomes enabled.
  const replyBtn = alice.getByRole("button", { name: /^Reply$/i }).first()
  await expect(replyBtn).toBeEnabled({ timeout: 3_000 })
  await replyBtn.click()

  // Reply text appears in the thread.
  await expect(alice.getByText(replyText)).toBeVisible({ timeout: 5_000 })

  // Reply input should be cleared.
  await expect(replyInput).toHaveValue("", { timeout: 3_000 })
})
