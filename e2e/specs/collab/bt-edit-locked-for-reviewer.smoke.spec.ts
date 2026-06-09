import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { ensureAuthState } from "../../helpers/auth"
import { addOrgMember, getMyOrg, addProjectMember, ROLE } from "../../helpers/frontier-api"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * EditorTable — BT "Edit" button is locked for Reviewer role.
 *
 * EditorTable.tsx: in the BT tab of the expanded cell, if the user's
 * role is below Contributor, the "Edit" button is a disabled span with:
 *   title="Contributor+ required to edit back-translations"
 *
 * This spec:
 *   1. Alice creates a project, imports sample.md, edits cell 0.
 *   2. Bob is added as a Reviewer.
 *   3. Bob opens cell details → BT tab.
 *   4. Verifies the locked "Edit" span is present.
 */
test("BT Edit is locked with Contributor+ tooltip for reviewer", async ({ alice, bob }) => {
  const aliceSession = await ensureAuthState("alice")
  const acme = await getMyOrg(aliceSession.jwt)
  await addOrgMember(aliceSession.jwt, acme.id, "bob", ROLE.REVIEWER)

  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `BTLocked ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()
  // Edit cell 0 so there's a translation (BT requires translated text).
  await ws.editCell(0, "Translation for BT locked test")

  // Extract project ID so bob can navigate to it.
  const projectId = alice.url().split("/project/")[1]?.split("/")[0]
  expect(projectId).toBeTruthy()

  // Add bob to this project directly with Reviewer role.
  await addProjectMember(aliceSession.jwt, projectId!, "bob", ROLE.REVIEWER)

  // Bob opens the project and file.
  await bob.goto(`/project/${projectId}`)
  await bob.waitForLoadState("networkidle")

  const bobWs = new Workspace(bob)
  await bobWs.openFileBySubstring("sample")
  await bobWs.waitForEditor()

  // Open cell details for row 0.
  const row = bobWs.cellRow(0)
  await row.scrollIntoViewIfNeeded()
  await row.hover()

  const expandBtn = row.getByRole("button", { name: /Open cell details/i })
  await expect(expandBtn).toBeVisible({ timeout: 8_000 })
  await expandBtn.click()

  // Switch to BT tab.
  const btTab = bob.getByRole("button", { name: /^BT$/i })
    .or(bob.getByRole("tab", { name: /^BT$/i }))
  await expect(btTab.first()).toBeVisible({ timeout: 5_000 })
  await btTab.first().click()

  // The locked Edit span should appear — Reviewer cannot edit BT.
  const lockedSpan = bob.locator('[title="Contributor+ required to edit back-translations"]')
  await expect(lockedSpan).toBeVisible({ timeout: 8_000 })
})
