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
  // Server-side-created projects have no source/target language, so the import
  // flow opens a blocking "Set translation direction" screen after the preview
  // step (ImportDialog.tsx `needsDirection`). Pre-seed the per-project skip key
  // (skipStorageKey) so importFile() completes unprompted.
  await alice.evaluate((id) => {
    localStorage.setItem(`codex.importDirectionSkipped.${id}`, "true")
  }, projectId)

  const aliceWs = new Workspace(alice)
  await aliceWs.importFile(SAMPLE_MD)
  await aliceWs.openFileBySubstring("sample")
  await aliceWs.waitForEditor()
  const translation = "Alice translation for validation"
  await aliceWs.editCell(0, translation)
  const fileId = alice.url().match(/\/file\/([^/?#]+)/)?.[1]
  expect(fileId, "imported file id should be present in the editor URL").toBeTruthy()

  // Bob opens the exact same file and waits for alice's projected edit. This
  // is the synchronization boundary the test cares about—not elapsed time.
  await bob.goto(`/project/${projectId}/file/${fileId}`)
  const bobWs = new Workspace(bob)
  await bobWs.waitForEditor()
  await expect(bobWs.cellRow(0)).toContainText(translation, { timeout: 20_000 })

  // Bob validates cell 0.
  await bobWs.validateCell(0)
})
