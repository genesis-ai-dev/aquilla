import { fileURLToPath } from "node:url"
import type { Page, Route } from "@playwright/test"
import { test, expect } from "../../helpers/multi-user"
import {
  jwtFor,
  openSeededProject,
  readSeededFileEvents,
  seedProjectWithFile,
  type SeededProject,
} from "../../helpers/seed-project"
import type { Workspace } from "../../helpers/page-objects/Workspace"

/**
 * AQU-1917 — transcription is a BACKGROUND job, never a gate on the document.
 *
 * The earlier automatic back-translation blocked users and cost them work. The
 * rule that replaced it: CTC passes, LLM cleanup, forced alignment and
 * autopilot re-drafts never make typing, saving (the outbox flush), sync or
 * navigation wait on them, a slow or failed job reports on its own cell rather
 * than in a modal, and model output never overwrites a human-edited cell.
 *
 * Both tests drive the real automatic-transcription path (a media import seeds
 * it — AQU-646) with the hosted ASR endpoint broken in the two ways that hurt:
 *
 *   a. it accepts the request and NEVER answers — the user can still edit a
 *      cell, save it, switch files and reload, and the edit survives;
 *   b. it answers 500 — the failure is confined to the job: no modal, the
 *      document is untouched, and the editor stays usable.
 *
 * Why smoke: a regression here loses a contributor's committed work, and the
 * assertion crosses SPA → sync-worker → Postgres (the edit is read back from
 * the event log and after a reload). The per-cell badge's own error/retry
 * rendering is covered in RTL (`CellTranscribeBadge.test.tsx`); this spec
 * covers the cross-layer guarantee that RTL cannot see.
 *
 * The hosted provider is the default (`transcription-preference.ts`), and the
 * hosted path takes no model-consent dialog, so stubbing this one endpoint is
 * enough to break transcription for the whole import.
 */

const ASR_ROUTE = "**/api/v1/audio/transcriptions"
const MEDIA_FIXTURE = fileURLToPath(new URL("../../fixtures/tone-segments.mp3", import.meta.url))
const MEDIA_NAME = "tone-segments.mp3"

interface Opened {
  jwt: string
  seeded: SeededProject
  ws: Workspace
}

async function openSeededTextProject(page: Page, label: string): Promise<Opened> {
  const jwt = await jwtFor("alice")
  const seeded = await seedProjectWithFile(jwt, { name: `${label} ${Date.now()}` })
  const ws = await openSeededProject(page, seeded)
  return { jwt, seeded, ws }
}

/** The committed target text of the seeded file's cells, read from the real
 *  event log through the same JWT → sync-token boundary the SPA uses. */
async function committedTargets(jwt: string, seeded: SeededProject): Promise<string[]> {
  const events = await readSeededFileEvents(jwt, seeded.projectId, seeded.fileId)
  return events
    .filter((event) => event.kind === "target.cell.commit")
    .map((event) => String((event.payload as { value?: unknown } | null)?.value ?? ""))
}

test("an ASR request that never answers never blocks editing, saving, navigation or reload", async ({ alice }) => {
  const { jwt, seeded, ws } = await openSeededTextProject(alice, "ASR hang")
  const EDIT = "edited while transcription hangs"

  // The hosted ASR endpoint accepts the request and never answers: this
  // handler settles nothing, so the fetch stays in flight for the whole test.
  // Anything that awaits it is therefore blocked forever, which is the point.
  const held: Route[] = []
  await alice.route(ASR_ROUTE, (route) => { held.push(route) })

  // A media import is what starts automatic transcription (AQU-646).
  await ws.startMediaImport(MEDIA_FIXTURE, MEDIA_NAME)
  await expect
    .poll(() => held.length, { timeout: 60_000 })
    .toBeGreaterThan(0)

  // The running job reports in a toast, never a modal over the workspace.
  await expect(ws.modalDialogs()).toHaveCount(0, { timeout: 30_000 })

  // With that request hanging, the document stays fully usable. `editCell`
  // waits for an OK `POST /events` and for the text to render, so a blocked
  // outbox or a frozen editor fails right here rather than at a timeout.
  // The media import leaves the Media view selected, so come back to Text —
  // the cell grid the contributor actually types in.
  await ws.openFileBySubstring(seeded.fileName)
  await ws.openTextView()
  await ws.waitForEditor()
  await ws.editCell(0, EDIT)

  // Navigation is not blocked either — away to the importing file and back.
  await ws.openFileBySubstring(MEDIA_NAME)
  await ws.openFileBySubstring(seeded.fileName)
  await ws.openTextView()
  await ws.waitForEditor()

  // The edit is durable, not just optimistic: it survives a reload, and the
  // event log in Postgres holds it.
  await alice.reload()
  await ws.openTextView()
  await ws.waitForEditor()
  await expect(ws.cellRow(0)).toContainText(EDIT, { timeout: 30_000 })
  expect(
    (await committedTargets(jwt, seeded)).some((value) => value.includes(EDIT)),
    "the committed edit is in the event log",
  ).toBe(true)

  // A background job never took the screen, and the ASR request it is waiting
  // on never did answer — the guarantee held while the job was still pending.
  await expect(ws.modalDialogs()).toHaveCount(0)
  expect(held.length, "the hanging ASR request was never answered").toBeGreaterThan(0)

  // Release the parked requests so teardown does not wait on them.
  for (const route of held) await route.abort().catch(() => {})
})

test("an ASR request that fails keeps the failure in the job: no modal, document untouched, editor usable", async ({ alice }) => {
  const { jwt, seeded, ws } = await openSeededTextProject(alice, "ASR failure")
  const EDIT = "edited after transcription failed"

  let asrCalls = 0
  await alice.route(ASR_ROUTE, async (route) => {
    asrCalls += 1
    await route.fulfill({ status: 500, json: { error: "transcription backend exploded" } })
  })

  await ws.startMediaImport(MEDIA_FIXTURE, MEDIA_NAME)
  await expect
    .poll(() => asrCalls, { timeout: 60_000 })
    .toBeGreaterThan(0)

  // The failure is reported, and it names the file whose job failed rather
  // than escalating to a modal over the workspace.
  await expect(alice.getByText(/Couldn't transcribe "tone-segments\.mp3"/))
    .toBeVisible({ timeout: 60_000 })
  await expect(ws.modalDialogs()).toHaveCount(0)

  // Nothing was written into the document on the model's behalf: a failed run
  // leaves no transcript and no target commit anywhere.
  const mediaFileEvents = await readSeededFileEvents(jwt, seeded.projectId, seeded.fileId)
  expect(mediaFileEvents.filter((event) => event.kind === "target.cell.commit")).toHaveLength(0)

  // And the editor still works: edit, save, reload, still there.
  await ws.openFileBySubstring(seeded.fileName)
  await ws.openTextView()
  await ws.waitForEditor()
  await ws.editCell(0, EDIT)
  await alice.reload()
  await ws.openTextView()
  await ws.waitForEditor()
  await expect(ws.cellRow(0)).toContainText(EDIT, { timeout: 30_000 })
  expect(
    (await committedTargets(jwt, seeded)).some((value) => value.includes(EDIT)),
    "the committed edit is in the event log",
  ).toBe(true)
})
