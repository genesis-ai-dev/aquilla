import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, ROLE } from "../../helpers/frontier-api"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Cross-user comment: alice posts a comment; bob (added as contributor)
 * opens the same project and sees alice's comment in the comments page.
 *
 * This tests the D1 comments projection — comments are server-persisted
 * and visible to all project members.
 */
test("alice posts comment; bob sees it on the comments page", async ({ alice, bob }) => {
  // Seed bob in alice's org and give him access to the project.
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.CONTRIBUTOR)

  // Alice creates a project and imports a file.
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `CrossComment ${Date.now()}`
  await dash.createProject({ name })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Extract project id from URL.
  const projectId = alice.url().split("/project/")[1]?.split("/")[0]
  expect(projectId).toBeTruthy()

  // Alice opens comments drawer and posts.
  const row = ws.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await row.hover()

  const addCommentBtn = row.locator('button[aria-label="Add comment"]')
  await expect(addCommentBtn).toBeVisible({ timeout: 5_000 })
  await addCommentBtn.click()

  const drawer = alice.locator("[data-testid='comments-drawer']").first()
  await expect(drawer).toBeVisible({ timeout: 5_000 })
  const commentText = `cross-comment-${Date.now()}`
  const textarea = drawer.locator("textarea").first()
  await textarea.waitFor({ state: "visible", timeout: 5_000 })
  await textarea.fill(commentText)
  const postBtn = drawer.getByRole("button", { name: /post|submit|send/i }).first()
  await expect(postBtn).toBeVisible()
  await postBtn.click()
  await expect(drawer).toContainText(commentText, { timeout: 8_000 })

  // Bob navigates to the comments page for the same project.
  await bob.goto(`/project/${projectId}/comments`)
  await bob.waitForLoadState("networkidle")

  // Bob sees alice's comment.
  await expect(bob.getByText(commentText).first()).toBeVisible({ timeout: 10_000 })
})
