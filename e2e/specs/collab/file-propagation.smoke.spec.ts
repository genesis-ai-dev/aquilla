import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { ensureAuthState } from "../../helpers/auth"
import { createProjectServerSide, addProjectMember, ROLE } from "../../helpers/frontier-api"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Verify the partyserver sync layer: alice imports a file → bob sees it.
 *
 * The app is local-first; new projects exist only in IDB until "shared".
 * This spec uses the API to register the project server-side and add bob
 * as a member — equivalent to what the share UI does in production. With
 * server-side membership in place, the y-partyserver Durable Object accepts
 * connections from both alice and bob, sync establishes, and the file
 * propagates.
 */
// TODO(e2e): Architecture changed — y-partyserver/Yjs retired in favour of
// ProjectSync DO + D1 event log (sync-worker). The test's helpers
// createProjectServerSide/addProjectMember target the retired frontier-server
// API and the "local→synced bridge" concept no longer applies.
// Rewrite plan:
//   1. Create project via auth-worker POST /api/v2/projects (alice).
//   2. Add bob via POST /api/v2/projects/:id/members.
//   3. Alice imports file → sync-worker receives file.create event.
//   4. Assert: bob's GET /api/v2/projects/:id/files includes the new file.
//   5. UI: bob reloads workspace, sidebar shows the file.
// Keep test.fixme until the helpers and assertions are ported.
test.fixme("alice imports a file; bob (added via API) sees it via partyserver sync", async ({ alice, bob }) => {
  // 1. Alice creates the project via normal UI flow (populates her IDB).
  const aliceDash = new Dashboard(alice)
  await aliceDash.goto()
  const name = `Collab ${Date.now()}`
  await aliceDash.createProject({ name })
  await aliceDash.openProject(name)
  const projectId = alice.url().split("/project/")[1]?.split("/")[0]
  expect(projectId).toBeTruthy()

  // 2. Bridge local→synced: register server-side as alice, add bob as member.
  const aliceSession = await ensureAuthState("alice")
  await createProjectServerSide(aliceSession.jwt, { id: projectId!, name })
  await addProjectMember(aliceSession.jwt, projectId!, "bob", ROLE.CONTRIBUTOR)

  // 3. Alice imports the sample file.
  const aliceWs = new Workspace(alice)
  await aliceWs.importFile(SAMPLE_MD)
  await aliceWs.openFileBySubstring("sample")
  await aliceWs.waitForEditor()

  // 4. Bob navigates to his dashboard. The shared project should appear
  //    (server-side row + bob's membership = visible on his dashboard).
  const bobDash = new Dashboard(bob)
  await bobDash.goto()
  await expect(bob.getByText(name)).toBeVisible({ timeout: 15_000 })
  await bobDash.openProject(name)

  // 5. The file alice imported should propagate via partyserver sync.
  await expect(
    bob.locator("aside").locator("div").filter({ hasText: /sample/i }).first(),
  ).toBeVisible({ timeout: 20_000 })
})
