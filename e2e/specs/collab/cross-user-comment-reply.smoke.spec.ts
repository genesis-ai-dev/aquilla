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
  const commentBtn = row.locator("button[aria-label*='comment' i], button[title*='comment' i]").first()
  if (await commentBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await commentBtn.click()
  } else {
    const moreBtn = row.locator("button[aria-label*='More' i], button[aria-label*='actions' i]").first()
    await moreBtn.click()
    await alice.getByRole("menuitem", { name: /comment/i }).first().click()
  }

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
  await bob.waitForLoadState("networkidle")

  // Bob sees alice's comment.
  const bobComment = bob.getByText("Alice's initial comment").first()
  await expect(bobComment).toBeVisible({ timeout: 15_000 })

  // Bob replies to the comment.
  const replyInput = bob.locator('textarea[placeholder*="Reply" i]').first()
  await expect(replyInput).toBeVisible({ timeout: 5_000 })
  await replyInput.fill("Bob's reply")

  const replyBtn = bob.getByRole("button", { name: /reply|send/i }).first()
  await replyBtn.click()

  // Bob sees his reply in the thread.
  await expect(bob.getByText("Bob's reply").first()).toBeVisible({ timeout: 8_000 })
})
