// Tests for the client-side DOCX export with translation injection (AQU-233).
//
// SURGICAL STRING APPROACH: exportDocx now does in-place string replacement of
// paragraph run regions, not DOMParser+XMLSerializer. The XML declaration,
// namespaces, untranslated paragraphs, and all non-document.xml parts are
// byte-identical between input and output.
//
// We build minimal DOCX fixtures using JSZip (same lib the exporter uses)
// and verify that:
// 1. Translations are injected into the correct paragraphs.
// 2. Empty-translated cells leave the paragraph unchanged.
// 3. Heading style (w:pStyle) is preserved after injection.
// 4. Multi-segment paragraphs (shared group) join with a space.
// 5. Untranslated excess paragraphs remain untouched.
// 6. Bold run formatting (w:b in w:rPr) is preserved from source's baseRpr.
// 7. Italic run formatting (w:i in w:rPr) is preserved from source's baseRpr.
// 8. Font-size run formatting (w:sz in w:rPr) is preserved from source's baseRpr.
// 9. Paragraphs with NO rPr still inject successfully (no crash).
// 10. Translator's inline formatting (translatedHtml) wins for translated paragraphs.
// 11. XML declaration and namespaces are byte-identical (not reserialized).
// 12. Non-document.xml zip parts are byte-identical.

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

function makeCellWithHtml(
  id: string,
  original: string,
  translated: string,
  translatedHtml: string,
  group: string,
): CellData {
  return {
    ...makeCell(id, original, translated, group),
    translatedHtml,
  }
}

describe("exportDocx — translation injection (AQU-233)", () => {
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

describe("exportDocx — inline run formatting preservation (AQU-233)", () => {
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

// ---------------------------------------------------------------------------
// Surgical approach tests: translator formatting wins, byte-fidelity guarantees
// ---------------------------------------------------------------------------

/** Read word/document.xml from a blob as a string. */
async function readDocumentXml(blob: Blob): Promise<string> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer())
  return zip.file("word/document.xml")!.async("string")
}

describe("exportDocx — surgical approach (translator formatting wins, byte-fidelity)", () => {
  it("honors the translator's bold from translatedHtml, not the source's plain run", async () => {
    // Source paragraph is plain "alpha"; translator provides "a<strong>B</strong>".
    // The "B" span must be bold in the output; "a" must not be.
    const buffer = await makeDocx(para("alpha"))
    const cells = [makeCellWithHtml("c1", "alpha", "aB", "a<strong>B</strong>", "g0")]
    const { blob, injected } = await exportDocx(buffer, cells)
    expect(injected).toBe(1)
    const xml = await readDocumentXml(blob)
    // "a" run: plain (no rPr)
    expect(xml).toMatch(/<w:r><w:t xml:space="preserve">a<\/w:t><\/w:r>/)
    // "B" run: has w:b in rPr
    expect(xml).toMatch(/<w:rPr>[\s\S]*?<w:b\/>[\s\S]*?<\/w:rPr>/)
    expect(xml).toContain(">B<")
  })

  it("leaves untranslated paragraphs byte-identical", async () => {
    // Build the fixture and capture the EXACT untranslated paragraph XML up front.
    // We then assert that exact substring appears verbatim in the output — a mutation
    // to its attributes or rPr would fail this test (unlike a plain toContain("keep me")).
    const untranslatedPara = paraWithRpr("keep me", "<w:b/>")
    const buffer = await makeDocx(untranslatedPara + para("translate me"))
    const originalZip = await JSZip.loadAsync(buffer)
    const originalXml = await originalZip.file("word/document.xml")!.async("string")
    // Extract the exact paragraph block from the original XML so the assertion is
    // structural, not just a text-content check.
    const paraBlockMatch = originalXml.match(/<w:p\b[^>]*>(?:(?!<\/w:p>)[\s\S])*keep me[\s\S]*?<\/w:p>/)
    expect(paraBlockMatch).not.toBeNull()
    const exactParaBlock = paraBlockMatch![0]

    const cells = [
      makeCell("c1", "keep me", "", "g0"),      // untranslated
      makeCell("c2", "translate me", "DONE", "g1"),
    ]
    const { blob, injected, untouched } = await exportDocx(buffer, cells)
    expect(injected).toBe(1)
    expect(untouched).toBe(1)
    const xml = await readDocumentXml(blob)
    expect(xml).toContain("DONE")
    // The exact paragraph block (including attributes, rPr, etc.) must be verbatim in output.
    expect(xml).toContain(exactParaBlock)
  })

  it("does not change the XML declaration or namespaces of document.xml", async () => {
    const buffer = await makeDocx(para("x"))
    const originalZip = await JSZip.loadAsync(buffer)
    const before = await originalZip.file("word/document.xml")!.async("string")
    const { blob } = await exportDocx(buffer, [
      makeCellWithHtml("c1", "x", "y", "y", "g0"),
    ])
    const after = await readDocumentXml(blob)
    // The opening XML declaration and document element (first 120 chars) must be identical.
    // This verifies we did NOT call XMLSerializer (which would rewrite namespaces).
    expect(after.slice(0, 120)).toBe(before.slice(0, 120))
  })

  it("preserves non-document.xml zip parts byte-identical", async () => {
    // Add a styles.xml to the fixture so we can verify it's untouched.
    const stylesXml = `<?xml version="1.0"?><w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Normal"/></w:styles>`
    const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}">
  <w:body>${para("hello")}</w:body>
</w:document>`
    const zip = new JSZip()
    zip.file("word/document.xml", docXml)
    zip.file("word/styles.xml", stylesXml)
    const buffer = await zip.generateAsync({ type: "arraybuffer" })

    const { blob } = await exportDocx(buffer, [
      makeCell("c1", "hello", "hola", "g0"),
    ])
    const outZip = await JSZip.loadAsync(await blob.arrayBuffer())
    const outStyles = await outZip.file("word/styles.xml")!.async("string")
    expect(outStyles).toBe(stylesXml)
  })

  it("translator underline on translated text produces w:u in output", async () => {
    const buffer = await makeDocx(para("source"))
    const cells = [makeCellWithHtml("c1", "source", "translated", "<u>translated</u>", "g0")]
    const { blob, injected } = await exportDocx(buffer, cells)
    expect(injected).toBe(1)
    const xml = await readDocumentXml(blob)
    expect(xml).toContain('<w:u w:val="single"/>')
  })
})

// ---------------------------------------------------------------------------
// Self-closing <w:p/> adjacency — Critical regression guard (Finding 1)
// ---------------------------------------------------------------------------

describe("exportDocx — self-closing <w:p/> adjacency (Finding 1)", () => {
  it("self-closing <w:p/> immediately before a content paragraph: no fusion, no drop", async () => {
    // The old greedy regex fused <w:p/> with the next </w:p>, dropping "Real".
    // The new mutually-exclusive regex must keep them as separate matches.
    const selfClosing = `<w:p/>`
    const content = para("Real")
    const buffer = await makeDocx(selfClosing + content)
    const cells = [makeCell("c1", "Real", "Translated", "g1")]
    const { blob, injected, untouched } = await exportDocx(buffer, cells)

    // The self-closing para is empty → skipped; the content para is translated → injected=1.
    expect(injected).toBe(1)
    expect(untouched).toBe(0)

    const xml = await readDocumentXml(blob)
    // Self-closing survives intact.
    expect(xml).toContain("<w:p/>")
    // Content paragraph was translated, not dropped.
    expect(xml).toContain("Translated")
    expect(xml).not.toContain(">Real<")
    // The self-closing must remain a standalone token — it must NOT absorb the next
    // paragraph's content (no run XML should appear inside what used to be <w:p/>).
    // Verified indirectly: injected=1 and self-closing is still an empty <w:p/> element.
    expect(xml).toMatch(/<w:p\/>/)                       // self-closing untouched
    expect(xml).toMatch(/<w:p>[\s\S]*?Translated[\s\S]*?<\/w:p>/)
  })

  it("two consecutive <w:p/> before a content paragraph: all survive, content translated", async () => {
    const buffer = await makeDocx(`<w:p/><w:p/>` + para("Content"))
    const cells = [makeCell("c1", "Content", "Contenido", "g1")]
    const { blob, injected, untouched } = await exportDocx(buffer, cells)

    expect(injected).toBe(1)
    expect(untouched).toBe(0)

    const xml = await readDocumentXml(blob)
    // Both self-closing paras survive.
    const selfClosingCount = (xml.match(/<w:p\/>/g) ?? []).length
    expect(selfClosingCount).toBe(2)
    expect(xml).toContain("Contenido")
    expect(xml).not.toContain(">Content<")
  })

  it("self-closing <w:p/> does not increment the non-empty paragraph counter", async () => {
    // Three content paragraphs with one self-closing in the middle.
    // The cell ordering must still be positional over non-empty paras only.
    const buffer = await makeDocx(
      para("First") + `<w:p/>` + para("Second") + para("Third"),
    )
    const cells = [
      makeCell("c1", "First", "Primero", "g1"),
      makeCell("c2", "Second", "Segundo", "g2"),
      makeCell("c3", "Third", "Tercero", "g3"),
    ]
    const { blob, injected, untouched } = await exportDocx(buffer, cells)

    expect(injected).toBe(3)
    expect(untouched).toBe(0)

    const xml = await readDocumentXml(blob)
    expect(xml).toContain("Primero")
    expect(xml).toContain("Segundo")
    expect(xml).toContain("Tercero")
    // The self-closing must survive in output.
    expect(xml).toContain("<w:p/>")
  })
})
