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
 * Cell-level concurrent edit: alice types into cell 0, bob (with that
 * file open) sees the edit propagate via Yjs through the partyserver DO.
 *
 * Setup mirrors file-propagation.smoke: alice creates locally, then we
 * bridge local→synced via API.
 */
test("alice's edit on cell 0 is visible in bob's open editor within 10s", async ({ alice, bob }) => {
  // 1. Alice creates project locally
  const aliceDash = new Dashboard(alice)
  await aliceDash.goto()
  const name = `Concurrent ${Date.now()}`
  await aliceDash.createProject({ name })
  await aliceDash.openProject(name)
  const projectId = alice.url().split("/project/")[1]?.split("/")[0]
  expect(projectId).toBeTruthy()

  // 2. Bridge local→synced
  const aliceSession = await ensureAuthState("alice")
  await createProjectServerSide(aliceSession.jwt, { id: projectId!, name })
  await addProjectMember(aliceSession.jwt, projectId!, "bob", ROLE.CONTRIBUTOR)

  // 3. Alice imports + opens
  const aliceWs = new Workspace(alice)
  await aliceWs.importFile(SAMPLE_MD)
  await aliceWs.openFileBySubstring("sample")
  await aliceWs.waitForEditor()

  // 4. Bob opens the same project + file
  const bobDash = new Dashboard(bob)
  await bobDash.goto()
  await expect(bob.getByText(name)).toBeVisible({ timeout: 15_000 })
  await bobDash.openProject(name)
  const bobWs = new Workspace(bob)
  await bobWs.openFileBySubstring("sample")
  await bobWs.waitForEditor()

  // 5. Alice types
  const text = `from-alice-${Date.now()}`
  await aliceWs.editCell(0, text)

  // 6. Bob sees it. 10s budget covers DO round-trip + DOM update under load.
  await expect(bobWs.cellRow(0)).toContainText(text, { timeout: 10_000 })
})
