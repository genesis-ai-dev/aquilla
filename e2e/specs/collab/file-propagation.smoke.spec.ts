import { test, expect } from "../../helpers/multi-user"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { ensureAuthState } from "../../helpers/auth"
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
 * Verify the D1-event-log sync layer: alice imports a file → bob sees it.
 *
 * Architecture (v3 / AD-1):
 *   - Projects + file projections live in D1 (auth-worker's AQUILLA_PG).
 *   - The sync-worker's import-route writes `file.create` + `cell.genesis`
 *     events and projects them into the `files`/`cells` D1 tables on the
 *     same request. There is no async lag for file visibility.
 *   - Both alice and bob read project state from the auth-worker server;
 *     IDB is a local write-buffer, not the read path for project structure.
 *
 * Setup: create the project + add bob via API (auth-worker), then let alice
 * drive the import through the UI. Check bob's API and then his UI.
 */
test("alice imports a file; bob (added via API) sees it in his workspace", async ({ alice, bob }) => {
  const aliceSession = await ensureAuthState("alice")
  const bobSession = await ensureAuthState("bob")

  // 1. Register project server-side + add bob as contributor.
  const projectId = `collab-fp-${Date.now()}`
  const projectName = `Collab FP ${Date.now()}`
  await createProjectServerSide(aliceSession.jwt, { id: projectId, name: projectName })
  await addProjectMember(aliceSession.jwt, projectId, "bob", ROLE.CONTRIBUTOR)

  // 2. Alice navigates to the project workspace directly and imports the file.
  //    useProject reads from the server (thin client), so direct navigation
  //    works even though the project was registered server-side, not via the UI.
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

  // 3. The sync-worker's import-route writes the `file.create` event and
  //    projects the file row into D1 synchronously. Poll the auth-worker API
  //    as bob to confirm the file is visible (no IDB state needed).
  const FRONTIER_BASE = process.env.VITE_FRONTIER_BASE ?? "http://127.0.0.1:8787"
  await expect.poll(async () => {
    const r = await fetch(`${FRONTIER_BASE}/api/v2/projects/${projectId}`, {
      headers: { Authorization: `Bearer ${bobSession.jwt}` },
    })
    if (!r.ok) return false
    const data = (await r.json()) as { files?: Array<{ id: string; name: string }> }
    return (data.files ?? []).some((f) => f.name.includes("sample"))
  }, {
    message: "file should appear in bob's project API response",
    timeout: 15_000,
  }).toBe(true)

  // 4. UI: bob navigates to the project; sidebar should list the file.
  await bob.goto(`/project/${projectId}/editor`)
  await expect(
    bob.locator("aside").locator("div").filter({ hasText: /sample/i }).first(),
  ).toBeVisible({ timeout: 15_000 })
})
