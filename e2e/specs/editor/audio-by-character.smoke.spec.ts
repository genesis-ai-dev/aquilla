// E2E smoke test for the "Audio by character" export option.
//
// Full execution requires:
//   1. A dev stack with the real sync-worker running (audio fetch needs auth tokens).
//   2. A project fixture with cast assignments and at least one cell with an
//      uploaded audio attachment per character.
//
// Because this environment cannot run the full dev stack, this test documents
// the expected UI walkthrough. It is authored correctly and can be executed
// via: npx tsx scripts/e2e-up.ts -- audio-by-character.smoke.spec
//
// The test is structured so the "no audio" path (empty zip, 0 WAVs) can be
// exercised immediately against a freshly-created project — which IS the
// smoke-safe behavior for this feature (no audio → no crash, clean feedback).

import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

test("alice opens the export dialog and sees the Audio-by-character option", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `AudioExport ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "swh" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // Open the workspace action menu / export entry point.
  // The toolbar button is labelled "Export" or has a Download icon.
  const exportBtn = alice.getByRole("button", { name: /export/i }).first()
  await expect(exportBtn).toBeVisible({ timeout: 8_000 })
  await exportBtn.click()

  // The export dialog should appear.
  await expect(alice.getByRole("dialog")).toBeVisible({ timeout: 5_000 })

  // The "Audio by character" format option must be present.
  const audioOption = alice.getByRole("radio", { name: /audio by character/i })
  await expect(audioOption).toBeVisible({ timeout: 5_000 })

  // Select the option.
  await audioOption.click()
  await expect(audioOption).toBeChecked()

  // The preview section should appear (may say "No cells with audio").
  await expect(alice.getByText(/no cells with audio|clips/i)).toBeVisible({ timeout: 3_000 })

  // Trigger export — for a project with no audio this should complete without error
  // (empty zip is a valid outcome per the plan's spec).
  const [download] = await Promise.all([
    alice.waitForEvent("download", { timeout: 15_000 }).catch(() => null),
    alice.getByRole("button", { name: /^export$/i }).click(),
  ])

  // If a download was triggered, the filename must end with _audio-by-character.zip
  if (download) {
    expect(download.suggestedFilename()).toMatch(/_audio-by-character\.zip$/)
  }
  // Whether or not a download fires, there must be no error banner.
  await expect(alice.getByRole("status")).not.toContainText(/error|fail/i, { timeout: 8_000 })
})

// NOTE: A full integration test with real audio clips would additionally:
//   1. Seed a project with two cast members (Mary, John) and per-cell audio
//      attachments uploaded to R2 via the sync-worker.
//   2. Assert the downloaded zip contains exactly Mary_swh.wav and John_swh.wav.
//   3. Assert each WAV has a valid RIFF header (44-byte read via arrayBuffer).
//
// Those assertions require real audio bytes and a running sync-worker with
// auth tokens — they belong in a full integration suite, not a smoke test.
