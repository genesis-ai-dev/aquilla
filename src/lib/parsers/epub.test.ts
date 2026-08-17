import { describe, expect, it } from "vitest"
import JSZip from "jszip"
import type { CellData } from "@/hooks/useCells"
import { buildEpub, MIXED_SPINE_EPUB, TWO_CHAPTER_EPUB } from "./__fixtures__/build-epub"
import {
  classifyEpubMember,
  defaultEpubSkipMemberPaths,
  exportEpub,
  extractEpubImport,
  extractEpubStrings,
  filterEpubStrings,
} from "./epub"

function cellsFor(
  strings: Awaited<ReturnType<typeof extractEpubStrings>>,
  translations: string[],
): CellData[] {
  return strings.map((value, index) => ({
    id: value.id,
    fileId: "file-1",
    original: value.original,
    translated: translations[index] ?? "",
    context: value.context,
    group: value.group,
    type: value.type,
    status: "unvalidated",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    sourceLocation: value.sourceLocation,
  }))
}

describe("extractEpubStrings", () => {
  it("extracts spine chapters in reading order with member source locations", async () => {
    const strings = await extractEpubStrings(await buildEpub(TWO_CHAPTER_EPUB))
    expect(strings.map((value) => [value.original, value.type, value.section, value.sourceLocation])).toEqual([
      ["Chapter One", "heading", "Chapter One", { file: "OEBPS/Text/ch1.xhtml", blockPath: "0" }],
      ["The river was wide.", "text", "Chapter One", { file: "OEBPS/Text/ch1.xhtml", blockPath: "1" }],
      ["Chapter Two", "heading", "Chapter Two", { file: "OEBPS/Text/ch2.xhtml", blockPath: "0" }],
      ["The mountain was steep.", "text", "Chapter Two", { file: "OEBPS/Text/ch2.xhtml", blockPath: "1" }],
    ])
    expect(strings[1]?.originalHtml).toContain("<em>")
    expect(strings[1]?.context).toBe("Chapter One · Paragraph")
  })

  it("skips non-HTML spine members and still reads later chapters", async () => {
    const strings = await extractEpubStrings(await buildEpub({
      chapters: [
        { id: "css", href: "Styles/book.css", html: "p { color: red }", mediaType: "text/css" },
        {
          id: "ch1",
          href: "Text/only.xhtml",
          html: "<html><body><p>Only chapter.</p></body></html>",
        },
      ],
    }))
    expect(strings.map((value) => value.original)).toEqual(["Only chapter."])
  })

  it("resolves hrefs relative to the OPF and strips fragments", async () => {
    const strings = await extractEpubStrings(await buildEpub({
      opfPath: "OPS/package.opf",
      chapters: [{
        id: "intro",
        href: "../Text/intro.xhtml#start",
        html: "<html><body><p>Intro text.</p></body></html>",
      }],
    }))
    expect(strings[0]?.sourceLocation?.file).toBe("Text/intro.xhtml")
    expect(strings[0]?.original).toBe("Intro text.")
  })

  it("reads a chapter whose zip path differs only by case", async () => {
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
    <dc:identifier id="bookid">case</dc:identifier>
    <dc:title>Case Book</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="Text/Ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>`)
    zip.file("OEBPS/Text/ch1.xhtml", "<html><body><p>Case folded chapter.</p></body></html>")
    const strings = await extractEpubStrings(await zip.generateAsync({ type: "arraybuffer" }))
    expect(strings.map((value) => value.original)).toEqual(["Case folded chapter."])
  })

  it("rejects a zip that is not an EPUB package", async () => {
    const zip = new JSZip()
    zip.file("readme.txt", "not an epub")
    await expect(extractEpubStrings(await zip.generateAsync({ type: "arraybuffer" })))
      .rejects.toThrow(/missing META-INF\/container\.xml/i)
  })

  it("rejects an EPUB whose chapters have no extractable text", async () => {
    await expect(extractEpubStrings(await buildEpub({
      chapters: [{
        id: "empty",
        href: "Text/empty.xhtml",
        html: "<html><body><img src='cover.jpg' alt=''/></body></html>",
      }],
    }))).rejects.toThrow(/importable text/i)
  })

  it("does not extract the document title as a second heading", async () => {
    const strings = await extractEpubStrings(await buildEpub(MIXED_SPINE_EPUB))
    const chapter = strings.filter((value) => value.sourceLocation?.file.endsWith("ch1.xhtml"))
    expect(chapter.map((value) => value.original)).toEqual(["Chapter One", "The river was wide."])
  })
})

describe("EPUB member roles", () => {
  it("classifies nav, cover, notes, and chapters", () => {
    expect(classifyEpubMember({ id: "nav", href: "nav.xhtml", properties: "nav", linear: true, cellCount: 2 })).toBe("nav")
    expect(classifyEpubMember({ id: "cover", href: "Text/cover.xhtml", properties: "", linear: true, cellCount: 1 })).toBe("cover")
    expect(classifyEpubMember({ id: "n1", href: "Text/notes.xhtml", properties: "", linear: false, cellCount: 2 })).toBe("notes")
    expect(classifyEpubMember({ id: "ch1", href: "Text/ch1.xhtml", properties: "", linear: true, cellCount: 2 })).toBe("chapter")
    expect(classifyEpubMember({ id: "ch1", href: "Text/ch1.xhtml", properties: "", linear: true, cellCount: 0 })).toBe("empty")
  })

  it("defaults to chapters only and can filter the extracted strings", async () => {
    const extracted = await extractEpubImport(await buildEpub(MIXED_SPINE_EPUB))
    expect(extracted.members.map((member) => [member.role, member.includedByDefault, member.title])).toEqual([
      ["cover", false, "Cover"],
      ["nav", false, "Contents"],
      ["chapter", true, "Chapter One"],
      ["notes", false, "Endnotes"],
    ])
    const skip = defaultEpubSkipMemberPaths(extracted.members)
    expect([...skip].sort()).toEqual([
      "oebps/nav.xhtml",
      "oebps/text/cover.xhtml",
      "oebps/text/notes.xhtml",
    ])
    expect(filterEpubStrings(extracted.strings, skip).map((value) => value.original)).toEqual([
      "Chapter One",
      "The river was wide.",
    ])
  })
})

describe("exportEpub", () => {
  it("injects translations into the original spine members", async () => {
    const original = await buildEpub(TWO_CHAPTER_EPUB)
    const strings = await extractEpubStrings(original)
    const exported = await exportEpub(original, cellsFor(strings, [
      "Chapitre Un",
      "La rivière était large.",
      "Chapitre Deux",
      "La montagne était raide.",
    ]))
    const reextracted = await extractEpubStrings(await exported.arrayBuffer())
    expect(reextracted.map((value) => value.original)).toEqual([
      "Chapitre Un",
      "La rivière était large.",
      "Chapitre Deux",
      "La montagne était raide.",
    ])
    expect(reextracted.map((value) => value.sourceLocation?.file)).toEqual(
      strings.map((value) => value.sourceLocation?.file),
    )
  })

  it("leaves a chapter unchanged when no translation was supplied for it", async () => {
    const original = await buildEpub(TWO_CHAPTER_EPUB)
    const strings = await extractEpubStrings(original)
    const exported = await exportEpub(original, cellsFor(strings.slice(0, 2), [
      "Chapitre Un",
      "La rivière était large.",
    ]))
    const reextracted = await extractEpubStrings(await exported.arrayBuffer())
    expect(reextracted.map((value) => value.original)).toEqual([
      "Chapitre Un",
      "La rivière était large.",
      "Chapter Two",
      "The mountain was steep.",
    ])
  })
})
