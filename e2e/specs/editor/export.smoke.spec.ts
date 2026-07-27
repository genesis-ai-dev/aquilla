import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"
import { readFile, writeFile } from "node:fs/promises"
import JSZip from "jszip"

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
 * Export dialog smoke — the primary "Download <file>" action.
 *
 * What this covers:
 *  - ExportDialog opens from the header actions menu.
 *  - The headline action is a primary "Download <name>.<ext>" button in the
 *    file's OWN format (a .md import → "Download sample.md"); format
 *    conversions live behind the collapsed "Export to another format" section.
 *  - Clicking the primary button triggers a client-side Blob download that
 *    Playwright intercepts as a download event, named after the source file.
 *  - A DOCX source artifact is persisted atomically and can be downloaded in
 *    its original structure without a missing-source error.
 *
 * What this does NOT cover:
 *  - USFM/PPTX side-car round-trips (need fixtures + server code path).
 *  - Format conversions (covered by export-format-switch.smoke.spec.ts).
 *  - Project-scope zip (different code path; covered by manual verification).
 */
test("export dialog's primary action downloads the file back in its own format", async ({ alice }) => {
  const seeded = await seedProjectWithFile(await jwtFor("alice"), { name: `Export ${Date.now()}` })
  const ws = await openSeededProject(alice, seeded)

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
