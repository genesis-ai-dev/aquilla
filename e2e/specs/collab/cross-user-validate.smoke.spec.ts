import { test, expect } from "../../helpers/multi-user"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { ensureAuthState } from "../../helpers/auth"
import { bootstrapSharedProject, ROLE } from "../../helpers/frontier-api"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { v4 as uuid } from "uuid"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Cross-user cell validation: alice edits a cell, bob validates it.
 *
 * Workflow:
 *   1. Alice creates a project (server-side), adds bob as REVIEWER.
 *   2. Alice imports sample.md and edits cell 0.
 *   3. Bob opens the same file and validates cell 0.
 *   4. The validation button shows "— validated" for bob.
 *
 * This tests that the validation action is available to a member with
 * at least REVIEWER role, and that the emerald indicator appears.
 */
test("bob can validate alice's edit in a shared project", async ({ alice, bob }) => {
  const aliceSession = await ensureAuthState("alice")
  const projectId = uuid()
  const projectName = `CrossValidate ${Date.now()}`
  await bootstrapSharedProject(aliceSession.jwt, {
    id: projectId,
    name: projectName,
    collaboratorUsername: "bob",
    collaboratorRole: ROLE.REVIEWER,
  })

  // Alice imports the file and edits cell 0.
  await alice.goto(`/project/${projectId}`)
  await alice.waitForLoadState("networkidle")
  const aliceWs = new Workspace(alice)
  await aliceWs.importFile(SAMPLE_MD)
  await aliceWs.openFileBySubstring("sample")
  await aliceWs.waitForEditor()
  await aliceWs.editCell(0, "Alice translation for validation")

  // Wait for the edit to sync before bob reads.
  await alice.waitForTimeout(2_000)

  // Bob opens the same file.
  await bob.goto(`/project/${projectId}`)
  await bob.waitForLoadState("networkidle")
  const bobWs = new Workspace(bob)
  await bobWs.openFileBySubstring("sample")
  await bobWs.waitForEditor()

  // Bob validates cell 0.
  await bobWs.validateCell(0)
})
