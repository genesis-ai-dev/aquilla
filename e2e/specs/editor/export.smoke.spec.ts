import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Export dialog smoke — Bilingual TSV download.
 *
 * What this covers:
 *  - ExportDialog opens from the toolbar "Export file" button.
 *  - "Bilingual TSV" format radio is pre-selected (non-USFM files default to TSV).
 *  - Clicking "Export" triggers a client-side Blob download (URL.createObjectURL
 *    + programmatic anchor click) that Playwright intercepts as a download event.
 *  - The downloaded filename ends with ".tsv".
 *
 * What this does NOT cover:
 *  - USFM format (needs a .SFM fixture + different server code path).
 *  - Audio-by-character export (needs seeded audio blobs + AI key).
 *  - Project-scope zip (different code path; covered by manual verification).
 */
test("export dialog opens and downloads a TSV file for the open file", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Export ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(SAMPLE_MD)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // 1. Open the export dialog from the header overflow menu (AQU-331).
  await ws.openExportDialog()

  // The dialog should appear with the title "Export".
  const dialog = alice.getByRole("dialog")
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.getByRole("heading", { name: "Export" })).toBeVisible()

  // 2. Verify the Bilingual TSV radio is available and pre-selected (default for MD).
  const tsvRadio = dialog.locator('input[type="radio"][value="tsv"]')
  await expect(tsvRadio).toBeVisible({ timeout: 3_000 })
  await expect(tsvRadio).toBeChecked()

  // 3. Click "Export" and wait for the download event.
  //    exportTsv() builds a Blob and calls downloadBlob():
  //      URL.createObjectURL → <a href=…> → a.click()
  //    Playwright intercepts this as a "download" event on the page.
  const [download] = await Promise.all([
    alice.waitForEvent("download", { timeout: 10_000 }),
    dialog.getByRole("button", { name: /^Export$/i }).click(),
  ])

  // The filename should end with ".tsv".
  expect(download.suggestedFilename()).toMatch(/\.tsv$/i)

  // 4. Dismiss the dialog.
  await alice.keyboard.press("Escape")
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })
})
