import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * CommentThread — "Close with reply" resolves the thread with a reply.
 *
 * CommentThread.tsx renders a "Close with reply" button (canReply && canResolve)
 * that posts the reply text AND resolves the thread in one action.
 *
 * This spec: post a comment → fill the Reply textarea → click "Close with reply" →
 * verify the reply text appears in the thread AND the thread is resolved
 * (cell has no open comment indicator OR a resolved indicator is shown).
 */
test("CommentThread Close with reply posts reply and resolves thread", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `CloseWithReply ${Date.now()}`
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
  const initial = `thread-${Date.now()}`
  await commentInput.fill(initial)
  const postBtn = alice.getByRole("button", { name: /post|submit|send/i }).first()
  await expect(postBtn).toBeEnabled({ timeout: 3_000 })
  await postBtn.click()
  await expect(alice.getByText(initial)).toBeVisible({ timeout: 5_000 })

  // Fill the reply textarea.
  const replyInput = alice.locator('textarea[placeholder="Reply..."]').first()
  await expect(replyInput).toBeVisible({ timeout: 5_000 })
  const replyText = `closing-reply-${Date.now()}`
  await replyInput.fill(replyText)

  // Click "Close with reply".
  const closeBtn = alice.getByRole("button", { name: /Close with reply/i }).first()
  await expect(closeBtn).toBeEnabled({ timeout: 3_000 })
  await closeBtn.click()

  // Reply text appears in the thread.
  await expect(alice.getByText(replyText)).toBeVisible({ timeout: 5_000 })

  // Thread is now resolved (the "Resolve" button disappears, or a resolved state shows).
  await expect(alice.getByRole("button", { name: /^Resolve$/i })).not.toBeVisible({ timeout: 3_000 })
})
