import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

/**
 * Export dialog smoke — the primary "Download <file>" action.
 *
 * What this covers (export-ergonomics redesign):
 *  - ExportDialog opens from the header actions menu.
 *  - The headline action is a primary "Download <name>.<ext>" button in the
 *    file's OWN format (a .md import → "Download sample.md"); format
 *    conversions live behind the collapsed "Export to another format" section.
 *  - Clicking the primary button triggers a client-side Blob download that
 *    Playwright intercepts as a download event, named after the source file.
 *
 * What this does NOT cover:
 *  - USFM/DOCX/PPTX side-car round-trips (need fixtures + server code path).
 *  - Format conversions (covered by export-format-switch.smoke.spec.ts).
 *  - Project-scope zip (different code path; covered by manual verification).
 */
test("export dialog's primary action downloads the file back in its own format", async ({ alice }) => {
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

  // 2. The primary action is a big "Download sample.md" button — the file's
  //    own format, no format picking required.
  const primary = dialog.getByRole("button", { name: /^Download sample\.md$/i })
  await expect(primary).toBeVisible({ timeout: 3_000 })

  // The conversion section is collapsed by default for files with a native format.
  await expect(dialog.getByText("Export to another format")).toBeVisible()
  await expect(dialog.getByRole("radiogroup", { name: "Export format" })).not.toBeVisible()

  // 3. Click the primary download and wait for the download event.
  //    exportMarkdownStructured() builds a Blob and calls downloadBlob():
  //      URL.createObjectURL → <a href=…> → a.click()
  //    Playwright intercepts this as a "download" event on the page.
  const [download] = await Promise.all([
    alice.waitForEvent("download", { timeout: 10_000 }),
    primary.click(),
  ])

  // The file comes back under its own name and extension.
  expect(download.suggestedFilename()).toMatch(/^sample\.md$/i)

  // 4. Dismiss the dialog.
  await alice.keyboard.press("Escape")
  await expect(dialog).not.toBeVisible({ timeout: 3_000 })
})
