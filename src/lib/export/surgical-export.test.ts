import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { surgicalExport } from "./surgical-export"
import type { ExportCell } from "@/lib/store/file-doc"

async function makeDocx(bodyXml: string): Promise<ArrayBuffer> {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${bodyXml}</w:body>
</w:document>`
  const zip = new JSZip()
  zip.file("word/document.xml", xml)
  return zip.generateAsync({ type: "arraybuffer" })
}

async function readDocxXml(buffer: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer)
  return zip.file("word/document.xml")!.async("string")
}

async function makePptx(slides: Record<string, string>): Promise<ArrayBuffer> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(slides)) {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>${content}</p:spTree></p:cSld>
</p:sld>`
    zip.file(`ppt/slides/${name}`, xml)
  }
  return zip.generateAsync({ type: "arraybuffer" })
}

async function readPptxXml(buffer: ArrayBuffer, name: string): Promise<string> {
  const zip = await JSZip.loadAsync(buffer)
  return zip.file(`ppt/slides/${name}`)!.async("string")
}

function cell(overrides: Partial<ExportCell> & { id: string }): ExportCell {
  return {
    original: "", translated: "", context: "", group: "", type: "text",
    ...overrides,
  }
}

describe("surgicalExport DOCX", () => {
  it("replaces text in a single paragraph", async () => {
    const buffer = await makeDocx(`<w:p><w:r><w:t>Hello</w:t></w:r></w:p>`)
    const cells: ExportCell[] = [
      cell({ id: "c1", original: "Hello", translated: "Bonjour", group: "g1",
             sourceLocation: { file: "word/document.xml", blockPath: "w:p[1]" } }),
    ]
    const resultBuffer = await surgicalExport(buffer, cells, "docx")
    const xml = await readDocxXml(resultBuffer)
    expect(xml).toContain("Bonjour")
    expect(xml).not.toContain("Hello")
  })

  it("replaces text in multiple paragraphs", async () => {
    const buffer = await makeDocx(`
      <w:p><w:r><w:t>First</w:t></w:r></w:p>
      <w:p><w:r><w:t>Second</w:t></w:r></w:p>
    `)
    const cells: ExportCell[] = [
      cell({ id: "c1", original: "First", translated: "Premier", group: "g1",
             sourceLocation: { file: "word/document.xml", blockPath: "w:p[1]" } }),
      cell({ id: "c2", original: "Second", translated: "Deuxième", group: "g2",
             sourceLocation: { file: "word/document.xml", blockPath: "w:p[2]" } }),
    ]
    const resultBuffer = await surgicalExport(buffer, cells, "docx")
    const xml = await readDocxXml(resultBuffer)
    expect(xml).toContain("Premier")
    expect(xml).toContain("Deuxième")
    expect(xml).not.toContain("First")
    expect(xml).not.toContain("Second")
  })

  it("reassembles split segments from same group", async () => {
    const buffer = await makeDocx(`<w:p><w:r><w:t>Long paragraph with two parts</w:t></w:r></w:p>`)
    const cells: ExportCell[] = [
      cell({ id: "c1", original: "Long paragraph", translated: "Long paragraphe", group: "g1",
             sourceLocation: { file: "word/document.xml", blockPath: "w:p[1]" } }),
      cell({ id: "c2", original: "with two parts", translated: "avec deux parties", group: "g1",
             sourceLocation: { file: "word/document.xml", blockPath: "w:p[1]" } }),
    ]
    const resultBuffer = await surgicalExport(buffer, cells, "docx")
    const xml = await readDocxXml(resultBuffer)
    expect(xml).toContain("Long paragraphe avec deux parties")
  })

  it("preserves paragraph style (pPr)", async () => {
    const buffer = await makeDocx(`
      <w:p>
        <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
        <w:r><w:rPr><w:b/></w:rPr><w:t>Title</w:t></w:r>
      </w:p>
    `)
    const cells: ExportCell[] = [
      cell({ id: "c1", original: "Title", translated: "Titre", group: "g1",
             sourceLocation: { file: "word/document.xml", blockPath: "w:p[1]" } }),
    ]
    const resultBuffer = await surgicalExport(buffer, cells, "docx")
    const xml = await readDocxXml(resultBuffer)
    expect(xml).toContain("Titre")
    expect(xml).toContain("Heading1")
  })

  it("falls back to original when translated is empty", async () => {
    const buffer = await makeDocx(`<w:p><w:r><w:t>Hello</w:t></w:r></w:p>`)
    const cells: ExportCell[] = [
      cell({ id: "c1", original: "Hello", translated: "", group: "g1",
             sourceLocation: { file: "word/document.xml", blockPath: "w:p[1]" } }),
    ]
    const resultBuffer = await surgicalExport(buffer, cells, "docx")
    const xml = await readDocxXml(resultBuffer)
    expect(xml).toContain("Hello")
  })

  it("skips cells without sourceLocation", async () => {
    const buffer = await makeDocx(`<w:p><w:r><w:t>Hello</w:t></w:r></w:p>`)
    const cells: ExportCell[] = [
      cell({ id: "c1", original: "Hello", translated: "Bonjour", group: "g1" }),
    ]
    const resultBuffer = await surgicalExport(buffer, cells, "docx")
    const xml = await readDocxXml(resultBuffer)
    expect(xml).toContain("Hello")
    expect(xml).not.toContain("Bonjour")
  })
})

describe("surgicalExport PPTX", () => {
  it("replaces text in a slide paragraph", async () => {
    const buffer = await makePptx({
      "slide1.xml": `
        <p:sp><p:txBody>
          <a:p><a:r><a:t>Hello</a:t></a:r></a:p>
        </p:txBody></p:sp>
      `,
    })
    const cells: ExportCell[] = [
      cell({ id: "c1", original: "Hello", translated: "Bonjour", group: "g1",
             sourceLocation: { file: "ppt/slides/slide1.xml", blockPath: "p:sp[1]/p:txBody/a:p[1]" } }),
    ]
    const resultBuffer = await surgicalExport(buffer, cells, "pptx")
    const xml = await readPptxXml(resultBuffer, "slide1.xml")
    expect(xml).toContain("Bonjour")
    expect(xml).not.toContain("Hello")
  })

  it("replaces text across multiple slides", async () => {
    const buffer = await makePptx({
      "slide1.xml": `<p:sp><p:txBody><a:p><a:r><a:t>Slide1</a:t></a:r></a:p></p:txBody></p:sp>`,
      "slide2.xml": `<p:sp><p:txBody><a:p><a:r><a:t>Slide2</a:t></a:r></a:p></p:txBody></p:sp>`,
    })
    const cells: ExportCell[] = [
      cell({ id: "c1", original: "Slide1", translated: "Diapo1", group: "g1",
             sourceLocation: { file: "ppt/slides/slide1.xml", blockPath: "p:sp[1]/p:txBody/a:p[1]" } }),
      cell({ id: "c2", original: "Slide2", translated: "Diapo2", group: "g2",
             sourceLocation: { file: "ppt/slides/slide2.xml", blockPath: "p:sp[1]/p:txBody/a:p[1]" } }),
    ]
    const resultBuffer = await surgicalExport(buffer, cells, "pptx")
    expect(await readPptxXml(resultBuffer, "slide1.xml")).toContain("Diapo1")
    expect(await readPptxXml(resultBuffer, "slide2.xml")).toContain("Diapo2")
  })
})
