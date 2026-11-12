/**
 * AQU-1550 — merge a legacy sibling project into a host as one more target lane.
 *
 * Full-suite journey (not smoke: there is no UI for the merge yet, and nothing
 * is lost when it fails — the donor stays live). It exists because the merge
 * was broken end to end while every unit suite was green:
 *
 *   - the worker suites run on a test database that mints a lane record for any
 *     row written without one, so the fold's missing lane never surfaced; and
 *   - the identity route's test mocks the fold, so the call between the two
 *     workers (the service token the sync worker has to accept) was never made.
 *
 * This stack has neither crutch: real Postgres schema, real identity → sync
 * call. Bob drives it — alice is a platform admin here, which would exempt her
 * from the sync worker's check of the caller's role on the donor.
 *
 * Flow:
 *   1. Host: a project with sample.md imported.
 *   2. Sibling: its own project, linked to the host's source, so the two share
 *      cell ids the way legacy single-pair siblings do. Translate two cells.
 *   3. POST …/merge-sibling { donorProjectId, lane: "fr" }.
 *   4. The host has a real lane: a lane record, the tag in its settings, the
 *      switcher showing it with the sibling's text, the default lane untouched.
 *   5. The lane is an ordinary lane: Settings → Languages' rename works on it.
 */

import { randomUUID } from "node:crypto"
import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { resetBackend } from "../../helpers/seed"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"
import {
  createProjectServerSide,
  linkProjectToSource,
  mergeSiblingProject,
  readProjectLanes,
  readProjectSettings,
  renameProjectLane,
  setProjectLanguagePair,
} from "../../helpers/frontier-api"

// The backend reset rides on the `alice` fixture; a bob-only spec does its own.
test.beforeEach(async () => {
  await resetBackend()
})

test("merging a sibling project gives the host a real lane holding the sibling's translations", async ({ bob }) => {
  test.setTimeout(120_000)
  const jwt = await jwtFor("bob")
  const stamp = Date.now()

  const host = await seedProjectWithFile(jwt, { name: `MergeHost ${stamp}` })

  // The sibling reads the host's source, so its cells carry the host's ids.
  const donorId = randomUUID()
  const donorName = `MergeSibling ${stamp}`
  await createProjectServerSide(jwt, { id: donorId, name: donorName })
  // French is the old settings `targetLanguage: "fr"`. The source lane already
  // exists; its language is set there. The brief is the only settings write.
  await setProjectLanguagePair(jwt, donorId, {
    sourceLanguage: "English",
    sourceCode: "en",
    targetLanguage: "French",
    targetCode: "fr",
    translationBrief: { parameters: { purpose: "Sibling fixture project" } },
  })
  const link = await linkProjectToSource(jwt, donorId, {
    sourceProjectId: host.projectId,
    mode: "live",
    consumes: "source",
    gate: "head",
  })
  expect(link.seeded, "the sibling received the host's source at link time").toBe(true)

  // Translate two cells in the sibling, through the editor.
  const dash = new Dashboard(bob)
  await dash.goto()
  await dash.openProject(donorName)
  const donorWs = new Workspace(bob)
  await donorWs.openFileBySubstring("sample")
  await donorWs.waitForEditor(host.cellIds[0])
  const firstText = `Bonjour fusion ${stamp}`
  const secondText = `Deuxième fusion ${stamp}`
  await donorWs.editCell(0, firstText)
  await donorWs.editCell(1, secondText)

  // The merge itself.
  const merge = await mergeSiblingProject(jwt, host.projectId, { donorProjectId: donorId, lane: "fr" })
  expect(merge.body.error, "merge-sibling answered an error").toBeUndefined()
  expect(merge.status).toBe(200)
  expect(merge.body).toMatchObject({
    merged: 2,
    skipped: [],
    lane: "fr",
    actions: { laneRegistered: true, donorArchived: true, donorPointerWritten: true },
  })

  // The host has a real lane: a lane record and the tag in its registry.
  const lane = (await readProjectLanes(jwt, host.projectId)).find((row) => row.legacyTag === "fr")
  expect(lane).toMatchObject({ role: "target", name: "fr", langCode: "fr", archivedAt: null })
  expect((await readProjectSettings(jwt, host.projectId)).targetLanes).toEqual(["fr"])

  // The switcher shows it, holding the sibling's translations...
  const ws = await openSeededProject(bob, host)
  await ws.switchLane("fr")
  await expect(ws.cellRow(0)).toContainText(firstText, { timeout: 10_000 })
  await expect(ws.cellRow(1)).toContainText(secondText, { timeout: 10_000 })
  // ...and the host's default lane is as empty as it was.
  await ws.switchLane("")
  expect(await ws.readTargetText(0)).toBe("")
  expect(await ws.readTargetText(1)).toBe("")

  // An ordinary lane: the rename Settings → Languages performs works on it.
  expect(await renameProjectLane(jwt, host.projectId, lane!.id, `French ${stamp}`)).toBe(200)
  const renamed = (await readProjectLanes(jwt, host.projectId)).find((row) => row.id === lane!.id)
  expect(renamed?.name).toBe(`French ${stamp}`)
})
