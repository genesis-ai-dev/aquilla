// Tests for the client-side DOCX export with translation injection (FRO-233).
//
// We build minimal DOCX fixtures using JSZip (same lib the exporter uses)
// and verify that:
// 1. Translations are injected into the correct paragraphs.
// 2. Empty-translated cells leave the paragraph unchanged.
// 3. Heading style (w:pStyle) is preserved after injection.
// 4. Multi-segment paragraphs (shared group) join with a space.
// 5. Untranslated excess paragraphs remain untouched.

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
