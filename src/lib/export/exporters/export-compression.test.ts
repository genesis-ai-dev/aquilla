// AQU-889: OOXML exports must stay compressed.
//
// Tim reported that a file imported into Aquilla and exported again after only
// a couple of lines were changed came back at ~200KB. The edit delta was never
// the cause: `JSZip.generateAsync()` defaults to `compression: "STORE"`, so the
// DOCX and PPTX exporters — which reopen the source package, splice translated
// runs in, and re-zip — were rewriting *every* part uncompressed. A document
// Word had packed into a few KB came back an order of magnitude larger.
//
// These are size regressions, not implementation assertions: they say the
// export must be a small fraction of its own uncompressed byte total, and must
// not balloon relative to the file it came from. They fail on STORE whatever
// the exporters do internally, and they don't care which compression level a
// future change picks so long as the package is genuinely compressed.

import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { exportDocx } from "./docx"
import { exportPptx } from "./pptx"
import type { CellData } from "@/hooks/useCells"

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"

/**
 * A real Office package carries bulky, highly repetitive boilerplate — theme
 * and style definitions dwarf the text in a short document, and they are
 * exactly what an uncompressed re-zip inflates. Reproduce that shape so the
 * ratios below mean something.
 */
function bulkyStylesXml(): string {
  const style = (n: number) => (
    `<w:style w:type="paragraph" w:styleId="Style${n}">` +
    `<w:name w:val="Style ${n}"/><w:basedOn w:val="Normal"/><w:qFormat/>` +
    `<w:pPr><w:spacing w:before="240" w:after="120" w:line="259" w:lineRule="auto"/></w:pPr>` +
    `<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr>` +
    `</w:style>`
  )
  const styles = Array.from({ length: 300 }, (_, i) => style(i)).join("")
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}">${styles}</w:styles>`
}

function bulkyThemeXml(): string {
  const scheme = (n: number) => (
    `<a:fontScheme name="Scheme${n}">` +
    `<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
    `<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>` +
    `</a:fontScheme>`
  )
  const schemes = Array.from({ length: 200 }, (_, i) => scheme(i)).join("")
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="${A_NS}" name="Office Theme"><a:themeElements>${schemes}</a:themeElements></a:theme>`
}

/** Total uncompressed bytes of every part in a package. */
async function uncompressedBytes(pkg: Blob | ArrayBuffer): Promise<number> {
  const zip = await JSZip.loadAsync(pkg)
  const sizes = await Promise.all(
    Object.values(zip.files)
      .filter((entry) => !entry.dir)
      .map(async (entry) => (await entry.async("uint8array")).byteLength),
  )
  return sizes.reduce((total, size) => total + size, 0)
}

function makeCell(id: string, original: string, translated: string, group: string): CellData {
  return {
    id,
    fileId: "f1",
    original,
    translated,
    context: "Paragraph",
    group,
    type: "text",
    status: translated ? "unvalidated" : "empty",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
  }
}

/** A Word-shaped package: a couple of paragraphs plus bulky boilerplate. */
async function makeDocxPackage(): Promise<ArrayBuffer> {
  const paragraphs = [
    `<w:p><w:r><w:t>Hello world</w:t></w:r></w:p>`,
    `<w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p>`,
  ].join("")
  const zip = new JSZip()
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}"><w:body>${paragraphs}</w:body></w:document>`,
  )
  zip.file("word/styles.xml", bulkyStylesXml())
  zip.file("word/theme/theme1.xml", bulkyThemeXml())
  // Word writes a compressed package; compare like with like.
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE", compressionOptions: { level: 6 } })
}

/** A PowerPoint-shaped package: one slide plus the same bulky boilerplate. */
async function makePptxPackage(): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file(
    "ppt/slides/slide1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}"><p:cSld><p:spTree>` +
    `<p:sp><p:txBody><a:p><a:r><a:t>Hello world</a:t></a:r></a:p></p:txBody></p:sp>` +
    `<p:sp><p:txBody><a:p><a:r><a:t>Second shape text</a:t></a:r></a:p></p:txBody></p:sp>` +
    `</p:spTree></p:cSld></p:sld>`,
  )
  zip.file("ppt/theme/theme1.xml", bulkyThemeXml())
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="${P_NS}"/>`,
  )
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE", compressionOptions: { level: 6 } })
}

// A genuinely compressed OOXML package of repetitive XML lands far under half
// its uncompressed size; a STORE-packed one lands at (or just over) 100%.
const COMPRESSED_FRACTION_CEILING = 0.5
// A two-line edit cannot plausibly grow the package much; STORE blew this out
// by more than an order of magnitude.
const GROWTH_CEILING = 1.5

describe("OOXML exports stay compressed (AQU-889)", () => {
  it("exportDocx packs the output well under its uncompressed byte total", async () => {
    const buffer = await makeDocxPackage()
    const result = await exportDocx(buffer, [
      makeCell("c1", "Hello world", "Hola mundo", "g1"),
      makeCell("c2", "Second paragraph", "Segundo párrafo", "g2"),
    ])

    const raw = await uncompressedBytes(result.blob)
    expect(result.blob.size).toBeLessThan(raw * COMPRESSED_FRACTION_CEILING)
  })

  it("exportDocx does not balloon a package for a two-line edit", async () => {
    const buffer = await makeDocxPackage()
    const result = await exportDocx(buffer, [
      makeCell("c1", "Hello world", "Hola mundo", "g1"),
      makeCell("c2", "Second paragraph", "Segundo párrafo", "g2"),
    ])

    expect(result.blob.size).toBeLessThan(buffer.byteLength * GROWTH_CEILING)
  })

  it("exportDocx leaves untouched parts readable and byte-identical after compression", async () => {
    const buffer = await makeDocxPackage()
    const result = await exportDocx(buffer, [makeCell("c1", "Hello world", "Hola mundo", "g1")])

    const outZip = await JSZip.loadAsync(result.blob)
    expect(await outZip.file("word/styles.xml")!.async("string")).toBe(bulkyStylesXml())
    expect(await outZip.file("word/theme/theme1.xml")!.async("string")).toBe(bulkyThemeXml())
  })

  it("exportPptx packs the output well under its uncompressed byte total", async () => {
    const buffer = await makePptxPackage()
    const result = await exportPptx(buffer, [
      makeCell("c1", "Hello world", "Hola mundo", "g1"),
      makeCell("c2", "Second shape text", "Texto de la segunda forma", "g2"),
    ])

    const raw = await uncompressedBytes(result.blob)
    expect(result.blob.size).toBeLessThan(raw * COMPRESSED_FRACTION_CEILING)
  })

  it("exportPptx does not balloon a deck for a two-line edit", async () => {
    const buffer = await makePptxPackage()
    const result = await exportPptx(buffer, [
      makeCell("c1", "Hello world", "Hola mundo", "g1"),
      makeCell("c2", "Second shape text", "Texto de la segunda forma", "g2"),
    ])

    expect(result.blob.size).toBeLessThan(buffer.byteLength * GROWTH_CEILING)
  })

  it("exportPptx leaves untouched parts readable and byte-identical after compression", async () => {
    const buffer = await makePptxPackage()
    const result = await exportPptx(buffer, [makeCell("c1", "Hello world", "Hola mundo", "g1")])

    const outZip = await JSZip.loadAsync(result.blob)
    expect(await outZip.file("ppt/theme/theme1.xml")!.async("string")).toBe(bulkyThemeXml())
  })
})
