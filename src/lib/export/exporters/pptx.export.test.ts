// Tests for the client-side PPTX export with translation injection (FRO-152a).
//
// A minimal 2-slide fixture is built in-test with JSZip (fixture shape copied
// from parity/corpus/generate.ts buildPptx) and we verify:
// (a) injected/untouched counts
// (b) re-extraction via extractPptxStrings yields translated texts in order
// (c) output zip part list is a superset of the input zip part list
// (d) untranslated paragraphs keep their source text
// (e) a:t element count per slide is unchanged (blanked runs stay as elements)
// plus: first-run formatting (a:rPr) survives injection.

import { describe, it, expect, beforeEach } from "vitest"
import JSZip from "jszip"
import { exportPptx } from "./pptx"
import { extractPptxStrings } from "@/lib/parsers/pptx"
import type { CellData } from "@/hooks/useCells"

const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"

function slideXml(shapesXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}"><p:cSld><p:spTree>${shapesXml}</p:spTree></p:cSld></p:sld>`
}

function shape(...paragraphsXml: string[]): string {
  return `<p:sp><p:txBody>${paragraphsXml.join("")}</p:txBody></p:sp>`
}

/** Fixture deck: 2 slides, 2 shapes each, one multi-run paragraph, one empty paragraph. */
async function makePptx(): Promise<ArrayBuffer> {
  const zip = new JSZip()
  // Slide 1, shape 1: mixed-format paragraph with two runs (bold first run).
  // Slide 1, shape 2: single-run paragraph + an empty paragraph the parser skips.
  zip.file(
    "ppt/slides/slide1.xml",
    slideXml(
      shape(`<a:p><a:r><a:rPr b="1"/><a:t>Hello </a:t></a:r><a:r><a:t>world</a:t></a:r></a:p>`) +
      shape(`<a:p><a:r><a:t>Second shape text</a:t></a:r></a:p>`, `<a:p></a:p>`),
    ),
  )
  // Slide 2: one paragraph per shape; the second stays untranslated.
  zip.file(
    "ppt/slides/slide2.xml",
    slideXml(
      shape(`<a:p><a:r><a:t>Slide two title</a:t></a:r></a:p>`) +
      shape(`<a:p><a:r><a:t>Slide two body</a:t></a:r></a:p>`),
    ),
  )
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
  )
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
  )
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="${P_NS}"/>`,
  )
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>`,
  )
  return zip.generateAsync({ type: "arraybuffer" })
}

function makeCell(id: string, original: string, translated: string, group: string): CellData {
  return {
    id,
    fileId: "f1",
    original,
    translated,
    context: "Slide 1",
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

// Paragraph order across the deck (parser order): Hello world / Second shape
// text / Slide two title / Slide two body.
function fixtureCells(): CellData[] {
  return [
    makeCell("c1", "Hello world", "Hola mundo", "g1"),
    makeCell("c2", "Second shape text", "Texto de la segunda forma", "g2"),
    makeCell("c3", "Slide two title", "Título de la diapositiva dos", "g3"),
    makeCell("c4", "Slide two body", "", "g4"), // untranslated
  ]
}

describe("exportPptx — translation injection (FRO-152a)", () => {
  let buffer: ArrayBuffer

  beforeEach(async () => {
    buffer = await makePptx()
  })

  it("reports injected and untouched counts", async () => {
    const result = await exportPptx(buffer, fixtureCells())
    expect(result.injected).toBe(3)
    expect(result.untouched).toBe(1)
  })

  it("re-extracting with extractPptxStrings yields the translations in deck order", async () => {
    const result = await exportPptx(buffer, fixtureCells())
    const reExtracted = await extractPptxStrings(await result.blob.arrayBuffer())
    expect(reExtracted.map((s) => s.original)).toEqual([
      "Hola mundo",
      "Texto de la segunda forma",
      "Título de la diapositiva dos",
      "Slide two body",
    ])
    expect(reExtracted.map((s) => s.context)).toEqual(["Slide 1", "Slide 1", "Slide 2", "Slide 2"])
  })

  it("output zip part list is a superset of the input zip part list", async () => {
    const inZip = await JSZip.loadAsync(buffer)
    const result = await exportPptx(buffer, fixtureCells())
    const outZip = await JSZip.loadAsync(result.blob)
    const outParts = new Set(Object.keys(outZip.files))
    for (const part of Object.keys(inZip.files)) {
      expect(outParts.has(part)).toBe(true)
    }
  })

  it("untranslated paragraphs keep their source text", async () => {
    const result = await exportPptx(buffer, fixtureCells())
    const outZip = await JSZip.loadAsync(result.blob)
    const slide2 = await outZip.file("ppt/slides/slide2.xml")!.async("string")
    expect(slide2).toContain("Slide two body")
    expect(slide2).toContain("Título de la diapositiva dos")
  })

  it("keeps the a:t element count per slide unchanged (blanked runs remain as empty elements)", async () => {
    const inZip = await JSZip.loadAsync(buffer)
    const result = await exportPptx(buffer, fixtureCells())
    const outZip = await JSZip.loadAsync(result.blob)

    for (const slideFile of ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml"]) {
      const before = await inZip.file(slideFile)!.async("string")
      const after = await outZip.file(slideFile)!.async("string")
      const count = (xml: string): number =>
        new DOMParser().parseFromString(xml, "application/xml").getElementsByTagName("a:t").length
      expect(count(after)).toBe(count(before))
    }

    // The multi-run paragraph shows exactly the translation: first a:t carries
    // it, the second a:t is blank.
    const slide1 = await outZip.file("ppt/slides/slide1.xml")!.async("string")
    const doc = new DOMParser().parseFromString(slide1, "application/xml")
    const firstPara = doc.getElementsByTagName("a:p")[0]
    const textEls = firstPara.getElementsByTagName("a:t")
    expect(textEls[0].textContent).toBe("Hola mundo")
    expect(textEls[1].textContent).toBe("")
    expect(slide1).not.toContain("world")
  })

  it("preserves the first run's a:rPr formatting on the injected run", async () => {
    const result = await exportPptx(buffer, fixtureCells())
    const outZip = await JSZip.loadAsync(result.blob)
    const slide1 = await outZip.file("ppt/slides/slide1.xml")!.async("string")
    const doc = new DOMParser().parseFromString(slide1, "application/xml")
    const firstRun = doc.getElementsByTagName("a:r")[0]
    const rPr = firstRun.getElementsByTagName("a:rPr")[0]
    expect(rPr?.getAttribute("b")).toBe("1")
    expect(firstRun.getElementsByTagName("a:t")[0].textContent).toBe("Hola mundo")
  })

  it("joins multi-segment cells (shared group) with a space", async () => {
    const cells = [
      makeCell("c1a", "Hello", "Hola", "g1"),
      makeCell("c1b", "world", "mundo", "g1"),
      makeCell("c2", "Second shape text", "", "g2"),
      makeCell("c3", "Slide two title", "", "g3"),
      makeCell("c4", "Slide two body", "", "g4"),
    ]
    const result = await exportPptx(buffer, cells)
    expect(result.injected).toBe(1)
    expect(result.untouched).toBe(3)
    const reExtracted = await extractPptxStrings(await result.blob.arrayBuffer())
    expect(reExtracted[0].original).toBe("Hola mundo")
  })

  it("throws on a zip with no slide parts", async () => {
    const zip = new JSZip()
    zip.file("word/document.xml", "<w:document/>")
    const notPptx = await zip.generateAsync({ type: "arraybuffer" })
    await expect(exportPptx(notPptx, fixtureCells())).rejects.toThrow(/no ppt\/slides/)
  })
})
