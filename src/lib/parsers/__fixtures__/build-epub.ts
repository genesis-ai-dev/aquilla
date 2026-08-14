import JSZip from "jszip"

export interface EpubChapterSpec {
  id: string
  href: string
  html: string
  mediaType?: string
  linear?: "yes" | "no"
}

export interface EpubSpec {
  title?: string
  opfPath?: string
  chapters: EpubChapterSpec[]
  extraFiles?: Record<string, string>
}

function resolveFixturePath(opfPath: string, href: string): string {
  const withoutFragment = href.split("#")[0] ?? href
  const slash = opfPath.lastIndexOf("/")
  const base = slash >= 0 ? opfPath.slice(0, slash + 1) : ""
  const parts: string[] = []
  for (const part of `${base}${withoutFragment}`.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return parts.join("/")
}

/** Minimal EPUB 3 package for parser and import-path tests. */
export async function buildEpub(spec: EpubSpec): Promise<ArrayBuffer> {
  const zip = new JSZip()
  const opfPath = spec.opfPath ?? "OEBPS/content.opf"
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" })
  zip.file("META-INF/container.xml", `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`)
  const manifest = spec.chapters.map((chapter) => (
    `<item id="${chapter.id}" href="${chapter.href}" media-type="${chapter.mediaType ?? "application/xhtml+xml"}"/>`
  )).join("\n    ")
  const spine = spec.chapters.map((chapter) => (
    chapter.linear === "no"
      ? `<itemref idref="${chapter.id}" linear="no"/>`
      : `<itemref idref="${chapter.id}"/>`
  )).join("\n    ")
  zip.file(opfPath, `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">test-book</dc:identifier>
    <dc:title>${spec.title ?? "Test Book"}</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    ${manifest}
  </manifest>
  <spine>
    ${spine}
  </spine>
</package>`)
  for (const chapter of spec.chapters) {
    zip.file(resolveFixturePath(opfPath, chapter.href), chapter.html)
  }
  for (const [path, content] of Object.entries(spec.extraFiles ?? {})) {
    zip.file(path, content)
  }
  return zip.generateAsync({ type: "arraybuffer" })
}

export const TWO_CHAPTER_EPUB: EpubSpec = {
  chapters: [
    {
      id: "ch1",
      href: "Text/ch1.xhtml",
      html: "<html><body><h1>Chapter One</h1><p>The river was <em>wide</em>.</p></body></html>",
    },
    {
      id: "ch2",
      href: "Text/ch2.xhtml",
      html: "<html><body><h1>Chapter Two</h1><p>The mountain was steep.</p></body></html>",
    },
  ],
}
