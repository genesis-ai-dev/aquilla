import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, addProjectMember, getMyOrg, ROLE } from "../../helpers/frontier-api"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Cross-user comment reply: bob replies to alice's comment.
 *
 * Extends cross-user-comment.smoke.spec.ts. Verifies not just visibility
 * but that bob can POST a reply and that reply is persisted (shown in
 * the thread on bob's view).
 *
 * This tests the full round-trip for the reply path:
 *   emitCommentCreate (reply, parentCommentId set) → outbox → sync-worker
 *   → D1 comments projection → CommentsDrawer re-renders with reply.
 */
test("bob can reply to alice's comment in a shared project", async ({ alice, bob }) => {
  // Two full UI flows (alice posts; bob polls the comments page, then replies
  // from the editor drawer) plus the up-to-15s projection poll — needs more
  // than the 30s default budget.
  test.setTimeout(60_000)

  // Setup: seed bob in alice's org as contributor.
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

  // Alice creates project, imports file, posts a comment.
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `XReply ${Date.now()}`
  await dash.createProject({ name })
  await dash.openProject(name)

  const projectId = alice.url().split("/project/")[1]?.split("/")[0]
  expect(projectId).toBeTruthy()

  // Give bob access to alice's project.
  await addProjectMember(aliceSession.jwt, projectId!, "bob", ROLE.CONTRIBUTOR)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Alice opens the comments drawer and posts a root comment.
  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await row.hover()

  // Open cell action menu to find Add Comment.
  const commentBtn = row.getByRole("button", { name: /Add comment/i }).first()
  await expect(commentBtn).toBeVisible({ timeout: 10_000 })
  await commentBtn.click()

  // Type alice's comment and submit.
  const commentDrawer = alice.locator('[data-testid="comments-drawer"]')
  const threadInput = commentDrawer.locator('textarea, [contenteditable="true"]').first()
  await expect(threadInput).toBeVisible({ timeout: 10_000 })
  await threadInput.fill("Alice's initial comment")
  const submitBtn = commentDrawer.getByRole("button", { name: /send|submit|post|comment/i }).first()
  await submitBtn.click()

  // Confirm alice's comment appears.
  await expect(commentDrawer.getByText("Alice's initial comment").first()).toBeVisible({ timeout: 8_000 })

  // Now bob opens the same project's comments page.
  await bob.goto(`/project/${projectId}/comments`)
  // Bob sees alice's comment. The comments page fetches once on mount with no
  // live subscription (useComments loads on mount only), while alice's
  // comment.create drains via the 5s outbox interval — so bob's first fetch can
  // legitimately race the projection write. Poll through the page's own
  // Refresh button rather than weakening the cross-user assertion.
  const refreshBtn = bob.getByRole("button", { name: "Refresh" })
  const bobComment = bob.getByText("Alice's initial comment").first()
  await expect(async () => {
    await refreshBtn.click()
    await expect(bobComment).toBeVisible({ timeout: 1_500 })
  }).toPass({ timeout: 15_000 })

  // Replies are intentionally NOT wired from the comments page (CommentsPage's
  // composer says "Replies from this view are not yet wired — open the cell in
  // the editor to reply"), so bob replies from the cell's comments drawer.
  await bob.goto(`/project/${projectId}`)
  const bobWs = new Workspace(bob)
  await bobWs.openFileBySubstring("sample")
  await bobWs.waitForEditor()

  const bobRow = bobWs.cellRow(0)
  await bobRow.scrollIntoViewIfNeeded()
  await bobRow.hover()
  // Cell 0 already carries alice's comment, so the rail button is relabelled
  // "1 open comment" and the AQU-599 gutter chip ("1 open comment — open
  // comments") appears — the original "Add comment" label no longer exists.
  // Click the always-visible chip (suffix match dodges the rail button).
  await bobRow.locator('button[aria-label$="open comments"]').click()

  const bobDrawer = bob.locator('[data-testid="comments-drawer"]')
  await expect(bobDrawer).toBeVisible({ timeout: 5_000 })
  // The drawer fetches the thread fresh on open — alice's root comment is the
  // thread bob replies to (cross-user visibility in the editor view).
  await expect(bobDrawer.getByText("Alice's initial comment").first()).toBeVisible({ timeout: 8_000 })

  // Bob replies to the comment. CommentThread renders a "Reply..." textarea
  // and a "Reply" button per thread ("Close with reply" is excluded by ^$).
  const replyInput = bobDrawer.locator('textarea[placeholder*="Reply" i]').first()
  await expect(replyInput).toBeVisible({ timeout: 5_000 })
  await replyInput.fill("Bob's reply")
  await bobDrawer.getByRole("button", { name: /^Reply$/ }).first().click()

  // Bob sees his reply in the thread.
  await expect(bobDrawer.getByText("Bob's reply").first()).toBeVisible({ timeout: 8_000 })
})
