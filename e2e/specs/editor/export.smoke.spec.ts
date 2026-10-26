import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import { jwtFor, openSeededProject, seedProjectWithFile } from "../../helpers/seed-project"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import JSZip from "jszip"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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
 *  - Download original (AQU-656) returns the imported USFM bytes; the dialog's
 *    own download injects the committed translation into the same file.
 *  - "Export to another format" → Web page (AQU-2182) turns a USFM book into
 *    one self-contained HTML file: chapter index, superscript verse numbers,
 *    the committed translation, and markup typed into a cell escaped rather
 *    than rendered.
 *
 * What this does NOT cover:
 *  - USFM/PPTX reconstructed round-trips other than the original-vs-injected
 *    identity check below (need extra fixtures + server code path).
 *  - The other format conversions (txt, md, tsv, …) — unit-tested per
 *    exporter under src/lib/export/exporters/.
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

  // By exact name: AQU-1352's "Created DOCX export … in Personal" toast is also
  // role="dialog" with a heading that contains "Export".
  const dialog = alice.getByRole("dialog", { name: "Export", exact: true })
  await expect(dialog.getByRole("heading", { name: "Export", exact: true })).toBeVisible()
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

test("Download original returns imported USFM bytes, not the translation-injected export", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `Original USFM ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  const fixture = path.resolve(__dirname, "../../fixtures/sample.usfm")
  await ws.importFile(fixture)
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  const marker = `AQU656-${Date.now()}`
  const verseIndex = await ws.cellIndexWithSource("In the beginning God created")
  await ws.editCell(verseIndex, marker)

  const [originalDownload] = await Promise.all([
    alice.waitForEvent("download", { timeout: 15_000 }),
    ws.clickDownloadOriginal(),
  ])
  expect(originalDownload.suggestedFilename()).toMatch(/sample\.usfm$/i)
  const originalPath = await originalDownload.path()
  expect(originalPath).not.toBeNull()
  const originalText = await readFile(originalPath!, "utf8")
  expect(originalText).toContain("In the beginning God created the heavens and the earth.")
  expect(originalText).not.toContain(marker)

  // The Export dialog's primary action is the translation round-trip: the
  // committed translation injected into the same file. The dialog names a USFM
  // export `<stem>.SFM` whatever extension the upload had (AQU-437), so this is
  // NOT the `sample.usfm` that Download original hands back above.
  await ws.openExportDialog()
  const dialog = alice.getByRole("dialog")
  const primary = dialog.getByRole("button", { name: /^Download sample\.SFM$/ })
  await expect(primary).toBeVisible()
  const [injectedDownload] = await Promise.all([
    alice.waitForEvent("download", { timeout: 15_000 }),
    primary.click(),
  ])
  expect(injectedDownload.suggestedFilename()).toBe("sample.SFM")
  const injectedPath = await injectedDownload.path()
  expect(injectedPath).not.toBeNull()
  expect(await readFile(injectedPath!, "utf8")).toContain(marker)
})

test("Web page export writes the USFM book as one readable HTML file (AQU-2182)", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `HTML export ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importFile(path.resolve(__dirname, "../../fixtures/sample.usfm"))
  await ws.openFileBySubstring("sample")
  await ws.waitForEditor()

  // A translation that reads like markup must come out as characters, not as
  // a tag the reviewer's browser would render (or run).
  const marker = `AQU2182-${Date.now()} <b>bold</b>`
  const verseIndex = await ws.cellIndexWithSource("In the beginning God created")
  await ws.editCell(verseIndex, marker)

  await ws.openExportDialog()
  await ws.openExportFormatsSection()
  const dialog = alice.getByRole("dialog", { name: "Export", exact: true })
  // The radio's accessible name is its aria-label followed by the wrapping
  // label's text (the description included), so match the prefix; `.first()`
  // because the native input behind it can surface under the same name.
  await dialog.getByRole("radio", { name: /^Web page \(\.html\)/ }).first().click()
  const [download] = await Promise.all([
    alice.waitForEvent("download", { timeout: 15_000 }),
    dialog.getByRole("button", { name: /^Export$/i }).click(),
  ])
  expect(download.suggestedFilename()).toBe("sample.html")
  const downloadedPath = await download.path()
  expect(downloadedPath).not.toBeNull()
  const html = await readFile(downloadedPath!, "utf8")

  // One self-contained page: the book's name, a same-page chapter index, and
  // the translated verse under its superscript number.
  expect(html).toContain("<title>Genesis</title>")
  expect(html).toContain('<a href="#ch-GEN-1">1</a>')
  expect(html).toContain('<a href="#ch-GEN-2">2</a>')
  expect(html).toContain('<sup class="verse-number">1</sup> AQU2182-')
  expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;")
  expect(html).not.toContain("<b>bold</b>")
  // A verse nobody translated still reads — as its source text, marked.
  expect(html).toContain('class="verse untranslated"')
  expect(html).toContain("Thus the heavens and the earth were finished.")
  await expect(dialog.getByText(/Downloaded sample\.html/i)).toBeVisible()
})
