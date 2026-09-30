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
 *  - The three USFM downloads are three different files, and each is the side it
 *    claims to be: Download original (AQU-656) is the imported bytes, the export
 *    dialog's primary action is the translation round-trip, and Export source
 *    (AQU-1449) is the curated SOURCE with no translation in it.
 *
 * What this does NOT cover:
 *  - USFM/PPTX reconstructed round-trips other than the three-way side identity
 *    check below (need extra fixtures + server code path).
 *  - The source overlay's edit / hide / add matrix. That is server-side plan +
 *    serializer behaviour with no second layer in it, and lives against a real
 *    Postgres in `sync-worker/src/__tests__/export-route-source-side.test.ts`.
 *    What crosses layers here — and is the lie worth a browser — is a menu item
 *    that promises the source and hands over the target.
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

test("each USFM download is the side it claims: original bytes, translation round-trip, curated source", async ({ alice }) => {
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

  // The export dialog's primary action is the TARGET side: the committed
  // translation injected into the same file. Unchanged by AQU-1449.
  // The dialog names a USFM export `<stem>.SFM` whatever extension the upload
  // had (AQU-437), so this is NOT the `sample.usfm` that Download original
  // hands back above — matched case-sensitively so the two cannot be confused.
  await ws.openExportDialog()
  const dialog = alice.getByRole("dialog")
  const primary = dialog.getByRole("button", { name: /^Download sample\.SFM$/ })
  await expect(primary).toBeVisible()
  const [injectedDownload] = await Promise.all([
    alice.waitForEvent("download", { timeout: 15_000 }),
    primary.click(),
  ])
  // The button delivers the name it promises.
  expect(injectedDownload.suggestedFilename()).toBe("sample.SFM")
  const injectedPath = await injectedDownload.path()
  expect(injectedPath).not.toBeNull()
  expect(await readFile(injectedPath!, "utf8")).toContain(marker)
  await alice.keyboard.press("Escape")
  await expect(dialog).not.toBeVisible()

  // AQU-1449: "Export source" is the SOURCE side. The verse above is translated,
  // so a file carrying that translation is the target side under the wrong name —
  // which is exactly what this menu item used to return.
  const [sourceDownload] = await Promise.all([
    alice.waitForEvent("download", { timeout: 15_000 }),
    ws.clickExportSource(),
  ])
  const sourcePath = await sourceDownload.path()
  expect(sourcePath).not.toBeNull()
  const curatedSource = await readFile(sourcePath!, "utf8")
  expect(curatedSource).not.toContain(marker)
  // Nobody edited this verse's source, so it comes back as the upload wrote it.
  expect(curatedSource).toContain("In the beginning God created the heavens and the earth.")
})
