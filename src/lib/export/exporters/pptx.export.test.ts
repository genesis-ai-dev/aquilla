// Tests for the client-side PPTX export with translation injection (AQU-152a).
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

function withLocator(cell: CellData, memberPath: string, blockPath: string, segment = 0): CellData {
  return {
    ...cell,
    metadata: {
      aquillaImport: {
        sourceLocator: { kind: "package-block", memberPath, blockPath, segment },
        physicalOrder: segment,
      },
    },
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

describe("exportPptx — translation injection (AQU-152a)", () => {
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

  it("uses package locators instead of editor order when cells are reordered", async () => {
    const cells = [
      withLocator(
        makeCell("c3", "Slide two title", "Título correcto", ""),
        "ppt/slides/slide2.xml",
        "p:sp[1]/p:txBody/a:p[1]",
      ),
      withLocator(
        makeCell("c1", "Hello world", "Hola correcto", ""),
        "ppt/slides/slide1.xml",
        "p:sp[1]/p:txBody/a:p[1]",
      ),
    ]

    const result = await exportPptx(buffer, cells)
    const reExtracted = await extractPptxStrings(await result.blob.arrayBuffer())
    expect(reExtracted.map((value) => value.original)).toEqual([
      "Hola correcto",
      "Second shape text",
      "Título correcto",
      "Slide two body",
    ])
  })

  it("throws on a zip with no slide parts", async () => {
    const zip = new JSZip()
    zip.file("word/document.xml", "<w:document/>")
    const notPptx = await zip.generateAsync({ type: "arraybuffer" })
    await expect(exportPptx(notPptx, fixtureCells())).rejects.toThrow(/no ppt\/slides/)
  })
})

// ── AQU-1068: content added and removed in the app ───────────────────────────
//
// Same two rules as the Word exporter, with one hazard of its own: this one
// mutates a LIVE DOM collection, so inserting or removing a paragraph shifts
// the very indices the locator path is built on.

/** A cell somebody added in the app: the origin marker, and no locator. */
function addedPptxCell(id: string, translated: string): CellData {
  return {
    ...makeCell(id, "", translated, id),
    metadata: { aquillaOrigin: { version: 1, kind: "user-insert" } },
  }
}

async function slideXmlOf(blob: Blob, slide: number): Promise<string> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer())
  return zip.file(`ppt/slides/slide${slide}.xml`)!.async("string")
}

const removedPptxAt = (memberPath: string, blockPath: string) => ({
  metadata: {
    aquillaImport: {
      sourceLocator: { kind: "package-block", memberPath, blockPath, segment: 0 },
    },
  },
})

const S1_SHAPE1 = "p:sp[1]/p:txBody/a:p[1]"
const S1_SHAPE2 = "p:sp[2]/p:txBody/a:p[1]"

describe("exportPptx — content added in the app", () => {
  it("writes an added cell as a new paragraph after the one it follows", async () => {
    const bytes = await makePptx()
    const cells = [
      withLocator(makeCell("c1", "Hello world", "Bonjour", "g1"), "ppt/slides/slide1.xml", S1_SHAPE1),
      addedPptxCell("added", "Ajouté."),
      withLocator(makeCell("c2", "Second shape text", "Deuxième", "g2"), "ppt/slides/slide1.xml", S1_SHAPE2),
    ]
    const result = await exportPptx(bytes, cells)
    const xml = await slideXmlOf(result.blob, 1)

    expect(result.inserted).toBe(1)
    expect(xml.indexOf("Bonjour")).toBeLessThan(xml.indexOf("Ajouté."))
    expect(xml.indexOf("Ajouté.")).toBeLessThan(xml.indexOf("Deuxième"))
  })

  it("does not disturb the paragraphs AFTER it — the live-collection hazard", async () => {
    // `getElementsByTagName` returns a live list. Inserting into it while the
    // walk is running shifts pIdx and length underneath, so a later paragraph
    // gets skipped or matched against the wrong locator. The exporter snapshots
    // with Array.from for exactly this. Without that, "Deuxième" lands wrong.
    const bytes = await makePptx()
    const cells = [
      withLocator(makeCell("c1", "Hello world", "Bonjour", "g1"), "ppt/slides/slide1.xml", S1_SHAPE1),
      addedPptxCell("a1", "Un."),
      addedPptxCell("a2", "Deux."),
      withLocator(makeCell("c2", "Second shape text", "Deuxième", "g2"), "ppt/slides/slide1.xml", S1_SHAPE2),
    ]
    const result = await exportPptx(bytes, cells)
    const xml = await slideXmlOf(result.blob, 1)

    expect(result.inserted).toBe(2)
    expect(result.injected).toBe(2)
    expect(xml).toContain("Deuxième")
    expect(xml.indexOf("Un.")).toBeLessThan(xml.indexOf("Deux."))
    // THE ASSERTION THAT ACTUALLY CATCHES IT. Without the snapshot the two
    // inserted clones grow the live list mid-walk and are then WALKED AS IF
    // THEY WERE SOURCE PARAGRAPHS — they have no locator, so each is counted
    // untouched and this rises from 2 (slide two's pair) to 4. Every other
    // observable stays identical, which is why the bug would otherwise ship.
    expect(result.untouched).toBe(2)
  })

  it("leaves an UNTRANSLATED added cell out", async () => {
    const bytes = await makePptx()
    const cells = [
      withLocator(makeCell("c1", "Hello world", "Bonjour", "g1"), "ppt/slides/slide1.xml", S1_SHAPE1),
      addedPptxCell("added", ""),
    ]
    expect((await exportPptx(bytes, cells)).inserted).toBe(0)
  })

  it("adds nothing on a LEGACY deck with no locators", async () => {
    const bytes = await makePptx()
    const cells = [
      makeCell("c1", "Hello world", "Bonjour", "g1"),
      addedPptxCell("added", "Ajouté."),
      makeCell("c2", "Second shape text", "Deuxième", "g2"),
    ]
    const result = await exportPptx(bytes, cells)
    expect(result.inserted).toBe(0)
    expect(await slideXmlOf(result.blob, 1)).not.toContain("Ajouté.")
  })
})

describe("exportPptx — content removed in the app", () => {
  it("drops the paragraph whose cell was removed", async () => {
    const bytes = await makePptx()
    const cells = [
      withLocator(makeCell("c2", "Second shape text", "Deuxième", "g2"), "ppt/slides/slide1.xml", S1_SHAPE2),
    ]
    const result = await exportPptx(bytes, cells, {
      removedCells: [removedPptxAt("ppt/slides/slide1.xml", S1_SHAPE1)],
    })
    const xml = await slideXmlOf(result.blob, 1)

    expect(result.removed).toBe(1)
    expect(xml).not.toContain("Hello ")
    expect(xml).toContain("Deuxième")
  })

  it("KEEPS the client's paragraph when the cell is merely untranslated", async () => {
    const bytes = await makePptx()
    const cells = [
      withLocator(makeCell("c1", "Hello world", "", "g1"), "ppt/slides/slide1.xml", S1_SHAPE1),
      withLocator(makeCell("c2", "Second shape text", "Deuxième", "g2"), "ppt/slides/slide1.xml", S1_SHAPE2),
    ]
    const result = await exportPptx(bytes, cells)
    const xml = await slideXmlOf(result.blob, 1)

    expect(result.removed).toBe(0)
    expect(xml).toContain("Hello ")
  })

  it("removing one paragraph does not shift the next one's locator", async () => {
    // The same live-collection hazard from the other direction.
    const bytes = await makePptx()
    const cells = [
      withLocator(makeCell("c3", "Slide two title", "Titre deux", "g3"), "ppt/slides/slide2.xml", S1_SHAPE1),
      withLocator(makeCell("c4", "Slide two body", "Corps deux", "g4"), "ppt/slides/slide2.xml", S1_SHAPE2),
    ]
    const result = await exportPptx(bytes, cells, {
      removedCells: [removedPptxAt("ppt/slides/slide1.xml", S1_SHAPE1)],
    })

    expect(result.removed).toBe(1)
    const slide2 = await slideXmlOf(result.blob, 2)
    expect(slide2).toContain("Titre deux")
    expect(slide2).toContain("Corps deux")
  })

  it("changes nothing when the removed list is empty", async () => {
    const bytes = await makePptx()
    const cells = fixtureCells()
    const withEmpty = await slideXmlOf((await exportPptx(bytes, cells, { removedCells: [] })).blob, 1)
    const without = await slideXmlOf((await exportPptx(bytes, cells)).blob, 1)
    expect(withEmpty).toBe(without)
  })
})
