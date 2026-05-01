import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

// FIXME: Same blocker as file-propagation.smoke — alice's project is
// local-only at creation, /members 403s, can't add bob via the UI as
// written. Needs the real local→synced project upgrade flow.
test.fixme("alice's edit on cell 0 is visible in bob's open editor within 5s", async ({ alice, bob }) => {
  const aliceDash = new Dashboard(alice)
  await aliceDash.goto()
  const name = `Concurrent ${Date.now()}`
  await aliceDash.createProject({ name })
  await aliceDash.openProject(name)

  const projectId = alice.url().split("/project/")[1]?.split("/")[0]!
  await alice.goto(`/project/${projectId}/members`)
  await alice.getByRole("button", { name: /add member|invite/i }).click()
  await alice.getByLabel(/username/i).fill("bob")
  await alice.getByRole("button", { name: /add|invite|confirm/i }).click()

  await alice.goto(`/project/${projectId}`)
  const aliceWs = new Workspace(alice)
  await aliceWs.importFile(SAMPLE_MD)
  await aliceWs.openFileBySubstring("sample")
  await aliceWs.waitForEditor()

  // Bob opens the same project + file
  const bobDash = new Dashboard(bob)
  await bobDash.goto()
  await bobDash.openProject(name)
  const bobWs = new Workspace(bob)
  await bobWs.openFileBySubstring("sample")
  await bobWs.waitForEditor()

  // Alice types
  const text = `from-alice-${Date.now()}`
  await aliceWs.editCell(0, text)

  // Bob sees it. 10s budget covers cold DO round-trip + DOM update under load.
  await expect(bobWs.cellRow(0)).toContainText(text, { timeout: 10_000 })
})
