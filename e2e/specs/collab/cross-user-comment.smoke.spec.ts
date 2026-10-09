import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { ensureAuthState } from "../../helpers/auth"
import {
  addOrgMember,
  addProjectMember,
  getMyOrg,
  ROLE,
} from "../../helpers/frontier-api"
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
  // Alice's create→import→comment flow (~20s typical) plus bob's up-to-15s
  // projection poll, then bob's own editor open for the @mention check
  // (AQU-1815), can exceed the 30s default budget.
  test.setTimeout(60_000)

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
  await addProjectMember(
    aliceSession.jwt,
    projectId!,
    "bob",
    ROLE.CONTRIBUTOR,
  )
  // AQU-1815: carol shares bob's lane (both are added to every current lane)
  // and sits below the org roster floor like him, so she is a lane-mate the
  // @mention picker must name even though the roster is hidden from bob.
  await addOrgMember(aliceSession.jwt, acme.id, "carol", ROLE.CONTRIBUTOR)
  await addProjectMember(aliceSession.jwt, projectId!, "carol", ROLE.CONTRIBUTOR)

  // Alice opens comments drawer and posts.
  // AQU-200: comments live behind the rail's ⋯ overflow.
  const addCommentBtn = await ws.openRowAction(ws.cellRow(0), "Add comment")
  await addCommentBtn.click()

  const drawer = alice.locator("[data-testid='comments-drawer']").first()
  await expect(drawer).toBeVisible({ timeout: 5_000 })
  const commentText = `cross-comment-${Date.now()}`
  const composer = drawer.getByRole("textbox", { name: "New thread" })
  await composer.waitFor({ state: "visible", timeout: 5_000 })
  await composer.fill(commentText)
  const postBtn = drawer.getByRole("button", { name: /post|submit|send/i }).first()
  await expect(postBtn).toBeVisible()
  await postBtn.click()
  await expect(drawer).toContainText(commentText, { timeout: 8_000 })

  // Bob navigates to the comments page for the same project.
  await bob.goto(`/project/${projectId}/comments`)
  // Bob sees alice's comment. Bob arrives by a fresh navigation, so his first
  // fetch is the mount load, while alice's comment.create drains via the 5s
  // outbox interval — his first fetch can legitimately race the projection
  // write. Poll through the page's own Refresh button rather than weakening the
  // cross-user assertion.
  //
  // AQU-817: this used to read "no live subscription (useComments loads on
  // mount only)", which was the defect, not the design. useComments now also
  // re-reads when the tab regains focus and when the project socket reopens,
  // because the DO never replays (AD-1) and a frame missed during a socket gap
  // was otherwise lost to that client until a full page reload. The Refresh
  // polling below is still the right tool HERE — it pins the cross-user
  // projection contract without depending on which re-read trigger fires first
  // — but do not read it as evidence that a reader must act to see a peer's
  // comment. See src/hooks/useComments.focusRevalidate.test.ts for the
  // gap-recovery guard.
  const refreshBtn = bob.getByRole("button", { name: "Refresh" })
  await expect(async () => {
    await refreshBtn.click()
    await expect(bob.getByText(commentText).first()).toBeVisible({ timeout: 1_500 })
  }).toPass({ timeout: 15_000 })

  // AQU-1815: bob is a Contributor, below the org roster floor (Project Lead
  // under the defaults), so GET …/members 403s for him and the @mention
  // picker used to say "No one on this project to mention". It must still
  // name carol, who shares his lane, and alice, who owns the project — the
  // lane-scoped list crosses SPA → auth-worker → Postgres lane grants.
  // `/project/:id` alone is the Overview page; the workspace is `/project/:id/editor`.
  const bobWs = new Workspace(bob)
  await bob.goto(`/project/${projectId}/editor`)
  await bobWs.openFileBySubstring("sample")
  await bobWs.waitForEditor()
  // The row already carries alice's thread, so open it from the AQU-599
  // comment badge rather than the overflow's "Add comment" action.
  await bobWs.cellRow(0).getByRole("button", { name: /open comments$/i }).click()
  const bobDrawer = bob.locator("[data-testid='comments-drawer']").first()
  await expect(bobDrawer).toBeVisible()
  const bobComposer = bobDrawer.getByRole("textbox", { name: "New thread" })
  await bobComposer.waitFor({ state: "visible" })
  await bobComposer.click()
  await bobComposer.pressSequentially("@")
  await expect(bob.getByRole("option", { name: "@carol" })).toBeVisible()
  await expect(bob.getByRole("option", { name: "@alice" })).toBeVisible()
  await expect(bob.getByText("No one on this project to mention.")).toHaveCount(0)
})
