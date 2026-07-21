import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readFile, writeFile } from "node:fs/promises"
import JSZip from "jszip"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_MD = path.resolve(__dirname, "../../fixtures/sample.md")

async function writeMinimalDocx(filePath: string): Promise<void> {
  const zip = new JSZip()
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`)
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Round-trip source paragraph</w:t></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>`)
  await writeFile(filePath, await zip.generateAsync({ type: "nodebuffer" }))
}

/**
 * Export dialog smoke — converted TSV and native DOCX downloads.
 *
 * What this covers:
 *  - ExportDialog opens from the toolbar "Export file" button.
 *  - "Bilingual TSV" format radio is pre-selected (non-USFM files default to TSV).
 *  - A DOCX source is persisted and can be downloaded again in its native format.
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

test("DOCX import records its source and downloads the original structure", async ({ alice }, testInfo) => {
  const fixture = testInfo.outputPath("roundtrip-source.docx")
  await writeMinimalDocx(fixture)

  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `DOCX export ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(fixture)
  await ws.openFileBySubstring("roundtrip-source")
  await ws.waitForEditor()
  await ws.openExportDialog()

  const dialog = alice.getByRole("dialog")
  await expect(dialog.getByRole("heading", { name: "Export" })).toBeVisible()
  await expect(dialog.locator('input[type="radio"][value="docx"]')).toBeChecked()
  await expect(dialog.getByText(/no source blob recorded/i)).toHaveCount(0)

  const [download] = await Promise.all([
    alice.waitForEvent("download", { timeout: 15_000 }),
    dialog.getByRole("button", { name: /^Export$/i }).click(),
  ])
  expect(download.suggestedFilename()).toBe("roundtrip-source.docx")

  const downloadedPath = await download.path()
  expect(downloadedPath).not.toBeNull()
  const downloaded = await JSZip.loadAsync(await readFile(downloadedPath!))
  expect(await downloaded.file("word/document.xml")!.async("string"))
    .toContain("Round-trip source paragraph")
  await expect(dialog.getByText(/Downloaded roundtrip-source\.docx/i)).toBeVisible()
})
