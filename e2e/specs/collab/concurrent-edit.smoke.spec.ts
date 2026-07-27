import { test, expect } from "../../helpers/multi-user"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { ensureAuthState } from "../../helpers/auth"
import { waitForProjectSyncReady } from "../../helpers/project-sync"
import {
  createProjectServerSide,
  addProjectMember,
  ROLE,
} from "../../helpers/frontier-api"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Cell-level concurrent edit via the ProjectSync DO WebSocket.
 *
 * Architecture (v3 / AD-1):
 *   - Alice's edit is committed to IDB and emitted via `POST /events` to the
 *     sync-worker, which writes the cell.update event to D1 and broadcasts it
 *     through the project-scoped ProjectSync Durable Object WebSocket.
 *   - Both alice and bob connect to `/parties/project-sync/<projectId>` when
 *     they open the project workspace. The DO fan-out delivers the event to
 *     bob's open connection, which triggers a D1 re-read and cell re-render.
 *   - The 15s timeout covers the full round-trip: IDB flush → outbox → D1
 *     write → DO broadcast → bob's WS receive → React re-render.
 *
 * Setup: create project + add bob via API (skips UI share flow).
 */
test("alice edits cell 0; bob sees the new text in his open editor within 15s", async ({ alice, bob }) => {
  const aliceSession = await ensureAuthState("alice")

  // 1. Create project server-side + add bob as contributor.
  const projectId = `collab-ce-${Date.now()}`
  const projectName = `Concurrent ${Date.now()}`
  await createProjectServerSide(aliceSession.jwt, { id: projectId, name: projectName })
  await addProjectMember(aliceSession.jwt, projectId, "bob", ROLE.CONTRIBUTOR)

  // 2. Alice navigates to the project, imports the sample file, opens it.
  await alice.goto(`/project/${projectId}/editor`)
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

  // Read the file id from the URL so bob can navigate to the exact same file.
  const fileId = alice.url().match(/\/file\/([^/?#]+)/)?.[1] ?? null
  expect(fileId, "file id should be in the URL after opening file").toBeTruthy()

  // 3. Bob opens the same project and file BEFORE alice edits — both need to
  //    be connected to the ProjectSync DO to receive the broadcast.
  const bobSyncReady = waitForProjectSyncReady(bob, projectId)
  await Promise.all([
    bob.goto(`/project/${projectId}/editor/file/${fileId}`),
    bobSyncReady,
  ])
  const bobWs = new Workspace(bob)
  await bobWs.waitForEditor()

  // 4. Alice edits cell 0 and blurs. The edit is committed to IDB and flushed
  //    to the sync-worker outbox, which writes to D1 + broadcasts via DO.
  const editText = `concurrent-${Date.now()}`
  await aliceWs.editCell(0, editText)

  // 5. Bob's editor should show the updated text somewhere in the cell list.
  //    The ProjectSync DO delivers the event.applied frame to bob's WS
  //    connection → useCells calls revalidateCell() → D1 refetch → re-render.
  //    We filter to the specific cell that contains the edit text rather than
  //    checking a fixed row index — the virtualized list can render cells in varying
  //    DOM order depending on scroll position.
  await expect(
    bob.locator("[data-cell-id]").filter({ hasText: editText }).first(),
  ).toBeVisible({ timeout: 15_000 })
})
