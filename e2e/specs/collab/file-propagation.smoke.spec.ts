import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

// FIXME: This spec assumes alice can navigate to /project/:id/members and
// add bob via the UI. In practice the project is local-only on alice's
// device when first created (no server-side row), so /members 403s. The
// app handles this by surfacing an "invite to sync" prompt elsewhere, not
// the members page. Spec needs to follow the real local→synced upgrade flow.
test.fixme("alice imports a file; bob (added as member) sees it propagate", async ({ alice, bob }) => {
  const aliceDash = new Dashboard(alice)
  await aliceDash.goto()
  const name = `Collab ${Date.now()}`
  await aliceDash.createProject({ name })
  await aliceDash.openProject(name)

  // Add bob as a project member via the Members page
  const projectId = alice.url().split("/project/")[1]?.split("/")[0]!
  await alice.goto(`/project/${projectId}/members`)
  await alice.getByRole("button", { name: /add member|invite/i }).click()
  await alice.getByLabel(/username/i).fill("bob")
  await alice.getByRole("button", { name: /add|invite|confirm/i }).click()
  await expect(alice.getByText("bob")).toBeVisible({ timeout: 5_000 })

  // Alice imports
  await alice.goto(`/project/${projectId}`)
  const aliceWs = new Workspace(alice)
  await aliceWs.importFile(SAMPLE_MD)
  await aliceWs.openFileBySubstring("sample")
  await aliceWs.waitForEditor()

  // Bob navigates to the same project
  const bobDash = new Dashboard(bob)
  await bobDash.goto()
  await expect(bob.getByText(name)).toBeVisible({ timeout: 15_000 })
  await bobDash.openProject(name)

  // The file should appear in bob's sidebar within the partyserver propagation window
  await expect(
    bob.locator("aside").locator("div").filter({ hasText: /sample/i }),
  ).toBeVisible({ timeout: 20_000 })
})
