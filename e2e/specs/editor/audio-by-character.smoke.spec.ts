// E2E smoke test for the "Audio by character" export option.
//
// Selectors verified live against the running app (ExportDialog):
//   - toolbar opener:  header ⋯ menu → "Export file" (AQU-331)
//   - format option:   text "Audio by character" (the radio's <label>)
//   - scope lock:      "Whole project" tab is disabled for this format
//   - empty preview:   "No cells with audio found in this file."
//   - dialog action:   button "Export" (exact) inside the dialog
//
// A project imported from plain text has no audio, so this exercises the
// smoke-safe "no audio" path: the option renders, scope locks to file, the
// preview reports no audio, and exporting still yields a valid (empty) zip
// named <file>_audio-by-character.zip — no crash, clean feedback.

import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

test("alice sees Audio-by-character export, scope-locked to file, and gets a zip", async ({
  alice,
}) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `AudioExport ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "swh" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Open the export dialog from the header overflow menu (AQU-331).
  await ws.openExportDialog()
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await ws.openExportFormatsSection()

  // The "Audio by character" format option is present; select it.
  await dialog.getByText("Audio by character").click()

  // Scope locks to file: the "Whole project" scope tab is disabled for this format.
  await expect(dialog.getByRole("tab", { name: /whole project/i })).toBeDisabled()

  // A no-audio project reports no audio in the preview.
  await expect(dialog.getByText("No cells with audio found in this file.")).toBeVisible({
    timeout: 5_000,
  })

  // Exporting still completes and downloads a valid (empty) zip.
  const downloadPromise = alice.waitForEvent("download", { timeout: 15_000 })
  await dialog.getByRole("button", { name: "Export", exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/_audio-by-character\.zip$/)
})

// A full integration test (separate from this smoke test) would seed a project
// with two cast members and per-cell audio attachments in R2, then assert the
// downloaded zip contains one WAV per character with a valid RIFF header. That
// requires real audio bytes + a running sync-worker with auth tokens.
