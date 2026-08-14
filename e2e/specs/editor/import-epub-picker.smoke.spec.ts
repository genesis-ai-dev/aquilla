import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import JSZip from "jszip"

async function mixedSpineEpub(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" })
  zip.file("META-INF/container.xml", `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`)
  zip.file("OEBPS/content.opf", `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">picker-book</dc:identifier>
    <dc:title>Picker Book</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="cover" href="Text/cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="notes" href="Text/notes.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="cover"/>
    <itemref idref="nav"/>
    <itemref idref="ch1"/>
    <itemref idref="notes" linear="no"/>
  </spine>
</package>`)
  zip.file("OEBPS/Text/cover.xhtml", "<html><body><h1>Cover</h1><p>A painted front.</p></body></html>")
  zip.file("OEBPS/nav.xhtml", "<html><body><nav><h1>Contents</h1><ol><li>Chapter One</li></ol></nav></body></html>")
  zip.file(
    "OEBPS/Text/ch1.xhtml",
    "<html><head><title>Chapter One</title></head><body><h1>Chapter One</h1><p>The river was wide.</p></body></html>",
  )
  zip.file("OEBPS/Text/notes.xhtml", "<html><body><h1>Endnotes</h1><p>A hidden note.</p></body></html>")
  return zip.generateAsync({ type: "nodebuffer" })
}

test("EPUB preview skips nav, cover, and notes unless the user includes them", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `EPUB picker ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.previewImportPayload({
    name: "book.epub",
    mimeType: "application/epub+zip",
    buffer: await mixedSpineEpub(),
  })

  const picker = alice.getByTestId("epub-chapter-picker")
  await expect(picker).toBeVisible()
  await expect(alice.getByLabel("Include Cover")).not.toBeChecked()
  await expect(alice.getByLabel("Include Contents")).not.toBeChecked()
  await expect(alice.getByLabel("Include Chapter One")).toBeChecked()
  await expect(alice.getByLabel("Include Endnotes")).not.toBeChecked()

  await ws.confirmImportPreview()
  await ws.openFileBySubstring("book")
  await ws.waitForEditor()

  await expect(ws.cellRow(0)).toContainText("Chapter One")
  await expect(ws.cellRow(1)).toContainText("The river was wide.")
  await expect(alice.locator("[data-cell-id]")).toHaveCount(2)
  await expect(alice.getByText("A painted front.")).toHaveCount(0)
  await expect(alice.getByText("A hidden note.")).toHaveCount(0)
})
