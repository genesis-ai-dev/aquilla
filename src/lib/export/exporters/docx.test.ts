// Tests for the client-side DOCX export with translation injection (FRO-233).
//
// We build minimal DOCX fixtures using JSZip (same lib the exporter uses)
// and verify that:
// 1. Translations are injected into the correct paragraphs.
// 2. Empty-translated cells leave the paragraph unchanged.
// 3. Heading style (w:pStyle) is preserved after injection.
// 4. Multi-segment paragraphs (shared group) join with a space.
// 5. Untranslated excess paragraphs remain untouched.
// 6. Bold run formatting (w:b in w:rPr) is preserved after injection.
// 7. Italic run formatting (w:i in w:rPr) is preserved after injection.
// 8. Font-size run formatting (w:sz in w:rPr) is preserved after injection.
// 9. Paragraphs with NO rPr still inject successfully (no crash).

import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { exportDocx } from "./docx"
import type { CellData } from "@/hooks/useCells"

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

function para(text: string, style?: string): string {
  const pPr = style
    ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`
    : ""
  return `<w:p>${pPr}<w:r><w:t>${text}</w:t></w:r></w:p>`
}

/** paragraph with explicit run properties on the first (dominant) run */
function paraWithRpr(text: string, rPrInner: string, style?: string): string {
  const pPr = style
    ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`
    : ""
  return `<w:p>${pPr}<w:r><w:rPr>${rPrInner}</w:rPr><w:t>${text}</w:t></w:r></w:p>`
}

function emptyPara(): string {
  return `<w:p></w:p>`
}

async function makeDocx(paragraphsXml: string): Promise<ArrayBuffer> {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}">
  <w:body>${paragraphsXml}</w:body>
</w:document>`
  const zip = new JSZip()
  zip.file("word/document.xml", xml)
  return zip.generateAsync({ type: "arraybuffer" })
}

function makeCell(
  id: string,
  original: string,
  translated: string,
  group: string,
): CellData {
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

describe("exportDocx — translation injection (FRO-233)", () => {
  it("injects translated text into a single paragraph", async () => {
    const buffer = await makeDocx(para("Hello world"))
    const cells = [makeCell("c1", "Hello world", "Hola mundo", "g1")]
    const result = await exportDocx(buffer, cells)

    expect(result.injected).toBe(1)
    expect(result.untouched).toBe(0)

    // Parse output and verify the translated text appears.
    const outZip = await JSZip.loadAsync(result.blob)
    const outXml = await outZip.file("word/document.xml")!.async("string")
    expect(outXml).toContain("Hola mundo")
    expect(outXml).not.toContain("Hello world")
  })

  it("leaves paragraph unchanged when no translation provided", async () => {
    const buffer = await makeDocx(para("Untranslated text"))
    const cells = [makeCell("c1", "Untranslated text", "", "g1")]
    const result = await exportDocx(buffer, cells)

    expect(result.injected).toBe(0)
    expect(result.untouched).toBe(1)

    const outZip = await JSZip.loadAsync(result.blob)
    const outXml = await outZip.file("word/document.xml")!.async("string")
    expect(outXml).toContain("Untranslated text")
  })

  it("preserves heading style (w:pStyle) after injection", async () => {
    const buffer = await makeDocx(para("Chapter Title", "Heading1"))
    const cells = [makeCell("c1", "Chapter Title", "Título del Capítulo", "g1")]
    const result = await exportDocx(buffer, cells)

    expect(result.injected).toBe(1)

    const outZip = await JSZip.loadAsync(result.blob)
    const outXml = await outZip.file("word/document.xml")!.async("string")
    expect(outXml).toContain("Título del Capítulo")
    // Style is preserved.
    expect(outXml).toContain("Heading1")
  })

  it("joins multi-segment cells (shared group) with a space", async () => {
    const buffer = await makeDocx(para("A long paragraph with many words"))
    const cells = [
      makeCell("c1", "A long paragraph", "Un párrafo largo", "g1"),
      makeCell("c2", "with many words", "con muchas palabras", "g1"),
    ]
    const result = await exportDocx(buffer, cells)

    expect(result.injected).toBe(1)

    const outZip = await JSZip.loadAsync(result.blob)
    const outXml = await outZip.file("word/document.xml")!.async("string")
    expect(outXml).toContain("Un párrafo largo con muchas palabras")
  })

  it("handles multiple paragraphs in order", async () => {
    const buffer = await makeDocx(
      para("First paragraph") + para("Second paragraph") + para("Third paragraph"),
    )
    const cells = [
      makeCell("c1", "First paragraph", "Primer párrafo", "g1"),
      makeCell("c2", "Second paragraph", "Segundo párrafo", "g2"),
      makeCell("c3", "Third paragraph", "", "g3"), // untranslated
    ]
    const result = await exportDocx(buffer, cells)

    expect(result.injected).toBe(2)
    expect(result.untouched).toBe(1)

    const outZip = await JSZip.loadAsync(result.blob)
    const outXml = await outZip.file("word/document.xml")!.async("string")
    expect(outXml).toContain("Primer párrafo")
    expect(outXml).toContain("Segundo párrafo")
    expect(outXml).toContain("Third paragraph")
  })

  it("skips empty paragraphs (mirrors import parser skip-empty logic)", async () => {
    const buffer = await makeDocx(
      emptyPara() + para("Real content") + emptyPara(),
    )
    const cells = [makeCell("c1", "Real content", "Contenido real", "g1")]
    const result = await exportDocx(buffer, cells)

    expect(result.injected).toBe(1)

    const outZip = await JSZip.loadAsync(result.blob)
    const outXml = await outZip.file("word/document.xml")!.async("string")
    expect(outXml).toContain("Contenido real")
  })

  it("produces a valid zip with word/document.xml at the root", async () => {
    const buffer = await makeDocx(para("Test"))
    const cells = [makeCell("c1", "Test", "Prueba", "g1")]
    const result = await exportDocx(buffer, cells)

    const outZip = await JSZip.loadAsync(result.blob)
    expect(outZip.file("word/document.xml")).not.toBeNull()
  })
})

// Helper: parse output XML and query via DOM so assertions are namespace-aware.
async function parseOutputXml(blob: Blob): Promise<Document> {
  const outZip = await JSZip.loadAsync(blob)
  const xmlStr = await outZip.file("word/document.xml")!.async("string")
  return new DOMParser().parseFromString(xmlStr, "application/xml")
}

/** Return true if the document contains any element with localName matching `name` in W_NS. */
function hasWElement(doc: Document, localName: string): boolean {
  // Try prefixed first (real Word files), then namespace-qualified.
  const byTag = doc.getElementsByTagName(`w:${localName}`)
  if (byTag.length > 0) return true
  const byNs = doc.getElementsByTagNameNS(W, localName)
  return byNs.length > 0
}

/** Return true if any w:rPr descendant contains a w:sz with val matching `szVal`. */
function hasSzVal(doc: Document, szVal: string): boolean {
  const allSz = [
    ...Array.from(doc.getElementsByTagName("w:sz")),
    ...Array.from(doc.getElementsByTagNameNS(W, "sz")),
  ]
  return allSz.some((el) => el.getAttribute("w:val") === szVal || el.getAttribute("val") === szVal)
}

describe("exportDocx — inline run formatting preservation (FRO-233)", () => {
  it("preserves bold (w:b) from dominant run onto injected run", async () => {
    const buffer = await makeDocx(paraWithRpr("Bold text", "<w:b/>"))
    const cells = [makeCell("c1", "Bold text", "Texto en negrita", "g1")]
    const result = await exportDocx(buffer, cells)

    expect(result.injected).toBe(1)

    const outDoc = await parseOutputXml(result.blob)
    // Translated text must appear.
    expect(outDoc.documentElement.textContent).toContain("Texto en negrita")
    // The injected run must carry a w:b element (bold) — namespace-aware check.
    expect(hasWElement(outDoc, "b")).toBe(true)
  })

  it("preserves italic (w:i) from dominant run onto injected run", async () => {
    const buffer = await makeDocx(paraWithRpr("Italic text", "<w:i/>"))
    const cells = [makeCell("c1", "Italic text", "Texto en cursiva", "g1")]
    const result = await exportDocx(buffer, cells)

    expect(result.injected).toBe(1)

    const outDoc = await parseOutputXml(result.blob)
    expect(outDoc.documentElement.textContent).toContain("Texto en cursiva")
    // The injected run must carry a w:i element (italic).
    expect(hasWElement(outDoc, "i")).toBe(true)
  })

  it("preserves font-size (w:sz) from dominant run onto injected run", async () => {
    const buffer = await makeDocx(paraWithRpr("Large text", '<w:sz w:val="48"/>'))
    const cells = [makeCell("c1", "Large text", "Texto grande", "g1")]
    const result = await exportDocx(buffer, cells)

    expect(result.injected).toBe(1)

    const outDoc = await parseOutputXml(result.blob)
    expect(outDoc.documentElement.textContent).toContain("Texto grande")
    // The injected run must carry a w:sz element with val="48".
    expect(hasSzVal(outDoc, "48")).toBe(true)
  })

  it("preserves heading style AND bold rPr together", async () => {
    const buffer = await makeDocx(paraWithRpr("Bold Heading", "<w:b/>", "Heading1"))
    const cells = [makeCell("c1", "Bold Heading", "Encabezado en Negrita", "g1")]
    const result = await exportDocx(buffer, cells)

    expect(result.injected).toBe(1)

    const outDoc = await parseOutputXml(result.blob)
    expect(outDoc.documentElement.textContent).toContain("Encabezado en Negrita")
    // Heading style must survive.
    const outZip = await JSZip.loadAsync(result.blob)
    const rawXml = await outZip.file("word/document.xml")!.async("string")
    expect(rawXml).toContain("Heading1")
    // Bold must survive.
    expect(hasWElement(outDoc, "b")).toBe(true)
  })

  it("injects successfully when paragraph run has no rPr (no crash, no stray rPr)", async () => {
    // para() helper creates a run with no rPr — the exporter must not crash
    // and must not emit a <w:rPr> element in the injected run.
    const buffer = await makeDocx(para("Plain text"))
    const cells = [makeCell("c1", "Plain text", "Texto sin formato", "g1")]
    const result = await exportDocx(buffer, cells)

    expect(result.injected).toBe(1)

    const outDoc = await parseOutputXml(result.blob)
    expect(outDoc.documentElement.textContent).toContain("Texto sin formato")
    // No rPr in the injected run (no character formatting was present in source).
    expect(hasWElement(outDoc, "rPr")).toBe(false)
  })

  it("untranslated paragraph retains ALL its original runs untouched", async () => {
    // An untranslated paragraph with bold run must preserve original runs exactly.
    const buffer = await makeDocx(paraWithRpr("Keep me", "<w:b/>"))
    const cells = [makeCell("c1", "Keep me", "", "g1")] // no translation
    const result = await exportDocx(buffer, cells)

    expect(result.untouched).toBe(1)
    expect(result.injected).toBe(0)

    const outDoc = await parseOutputXml(result.blob)
    expect(outDoc.documentElement.textContent).toContain("Keep me")
    // Bold run must be preserved in the untouched paragraph.
    expect(hasWElement(outDoc, "b")).toBe(true)
  })
})
