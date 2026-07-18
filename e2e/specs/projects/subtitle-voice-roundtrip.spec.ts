/**
 * E2E: Subtitle `<v Name>` round-trip
 *
 * Imports a VTT with `<v Name>` voice tags and asserts the full round-trip:
 * exporting the file as WebVTT reproduces `<v Name>` cues (with their original
 * timecodes) for cast-assigned cells and plain text for the untagged line.
 * That single assertion proves the whole chain end-to-end — parse + tag strip,
 * find-or-create cast member, per-cell assignment (keyed to the real imported
 * cellIds), timecode persistence, and the explicit-only voice-tag rule.
 *
 * Selectors verified live against the running app (ExportDialog / Workspace).
 */

import path from "node:path"
import { fileURLToPath } from "node:url"
import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.resolve(__dirname, "../../fixtures/voices-roundtrip.vtt")

test("import VTT with <v Name> tags → cast created → WebVTT export round-trips", async ({
  alice,
}) => {
  // 1. Create + open a project.
  const dash = new Dashboard(alice)
  await dash.goto()
  const projectName = `VoiceRoundtrip ${Date.now()}`
  await dash.createProject({ name: projectName, source: "en", target: "fr" })
  await dash.openProject(projectName)

  // 2. Import the VTT fixture, then open the resulting file.
  const ws = new Workspace(alice)
  await ws.importFile(FIXTURE)
  await expect(alice.getByText("voices-roundtrip.vtt").first()).toBeVisible({ timeout: 10_000 })
  await ws.openFileBySubstring("voices-roundtrip")
  await ws.waitForEditor()

  // The fixture has four cues → four cells.
  await expect(alice.locator("[data-cell-id]")).toHaveCount(4, { timeout: 10_000 })

  // 3. Export as WebVTT and capture the downloaded file. AQU-331 moved
  // "Export file" into the header ⋯ overflow menu — use the helper.
  const downloadPromise = alice.waitForEvent("download", { timeout: 15_000 })
  await ws.openExportDialog()
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await dialog.getByText("WebVTT (subtitles)").click()
  await dialog.getByRole("button", { name: "Export", exact: true }).click()

  const download = await downloadPromise
  const readable = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of readable) chunks.push(Buffer.from(chunk))
  const content = Buffer.concat(chunks).toString("utf-8")

  // 4. Assert round-trip fidelity.
  expect(content).toContain("WEBVTT")
  // Cast-assigned cells carry their voice tag (cast was created + assigned).
  expect(content).toContain("<v Mary>In the beginning was the Word.</v>")
  expect(content).toContain("<v John>And the Word was with God.</v>")
  expect(content).toContain("<v Mary>And the Word was God.</v>")
  // Original cue timecodes survived import → D1 → read → export (Plan A).
  expect(content).toContain("00:00:01.000 --> 00:00:03.000")
  expect(content).toContain("00:00:03.500 --> 00:00:05.500")
  // The untagged narrator line stays plain (explicit-only rule).
  expect(content).toContain("Plain narrator line with no voice tag.")
  expect(content).not.toMatch(/<v [^>]+>Plain narrator/)
})
