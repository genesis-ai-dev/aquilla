import { test, expect } from "../../helpers/multi-user"
import { Dashboard } from "../../helpers/page-objects/Dashboard"
import { Workspace } from "../../helpers/page-objects/Workspace"
import JSZip from "jszip"

async function minimalEpub(): Promise<Buffer> {
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
    <dc:identifier id="bookid">e2e-book</dc:identifier>
    <dc:title>E2E Book</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`)
  zip.file(
    "OEBPS/Text/ch1.xhtml",
    "<html><body><h1>Chapter One</h1><p>The river was wide.</p></body></html>",
  )
  zip.file(
    "OEBPS/Text/ch2.xhtml",
    "<html><body><h1>Chapter Two</h1><p>The mountain was steep.</p></body></html>",
  )
  return zip.generateAsync({ type: "nodebuffer" })
}

test("alice imports an EPUB and sees spine-ordered chapter cells", async ({ alice }) => {
  const dash = new Dashboard(alice)
  await dash.goto()
  const name = `EPUB ${Date.now()}`
  await dash.createProject({ name, source: "en", target: "fr" })
  await dash.openProject(name)

  const ws = new Workspace(alice)
  await ws.importPayload({
    name: "book.epub",
    mimeType: "application/epub+zip",
    buffer: await minimalEpub(),
  })
  await ws.openFileBySubstring("book")
  await ws.waitForEditor()

  await expect(ws.cellRow(0)).toContainText("Chapter One")
  await expect(ws.cellRow(1)).toContainText("The river was wide.")
  await expect(ws.cellRow(2)).toContainText("Chapter Two")
  await expect(ws.cellRow(3)).toContainText("The mountain was steep.")
})
