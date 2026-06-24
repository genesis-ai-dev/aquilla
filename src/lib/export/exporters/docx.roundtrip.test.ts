import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { exportDocx } from "./docx"

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
function p(inner: string, pPr = "") { return `<w:p>${pPr}${inner}</w:p>` }
function run(text: string, rPr = "") { return `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>` }

async function buildRichFixture(): Promise<ArrayBuffer> {
  const body =
    p(run("Title"), "<w:pPr><w:pStyle w:val=\"Heading1\"/></w:pPr>") +                 // 1 heading
    p(run("First item"), "<w:pPr><w:numPr><w:ilvl w:val=\"0\"/><w:numId w:val=\"1\"/></w:numPr></w:pPr>") +
    p(run("Second item"), "<w:pPr><w:numPr><w:ilvl w:val=\"0\"/><w:numId w:val=\"1\"/></w:numPr></w:pPr>") +
    `<w:tbl><w:tr><w:tc>${p(run("Cell A"))}</w:tc><w:tc>${p(run("Cell B"))}</w:tc></w:tr></w:tbl>` +
    p(run("the ") + run("LORD", "<w:rPr><w:b/></w:rPr>"))                              // mixed-format
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>${body}</w:body></w:document>`
  const zip = new JSZip()
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>`)
  zip.file("word/media/image1.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  zip.file("word/document.xml", documentXml)
  return zip.generateAsync({ type: "arraybuffer" })
}

it("preserves table/list/image + untranslated paragraphs; honors translator marks", async () => {
  const raw = await buildRichFixture()
  const original = await JSZip.loadAsync(raw)
  const originalXml = await original.file("word/document.xml")!.async("string")

  // Translate ONLY the heading and the mixed-format paragraph (positions 0 and 5 of the
  // non-empty paragraph sequence: heading, item1, item2, cellA, cellB, mixed).
  // Leave list items + table cells untranslated (empty translation).
  const G = (i: number) => ({ group: `g${i}` })
  const cells = [
    { ...G(0), translated: "Titre", translatedHtml: "Titre" },                 // heading
    { ...G(1), translated: "", translatedHtml: "" },                            // list item 1
    { ...G(2), translated: "", translatedHtml: "" },                            // list item 2
    { ...G(3), translated: "", translatedHtml: "" },                            // cell A
    { ...G(4), translated: "", translatedHtml: "" },                            // cell B
    { ...G(5), translated: "le SEIGNEUR", translatedHtml: "le <strong>SEIGNEUR</strong>" }, // mixed
  ] as any

  const { blob, injected } = await exportDocx(raw, cells)
  expect(injected).toBe(2)
  const out = await JSZip.loadAsync(await blob.arrayBuffer())
  const xml = await out.file("word/document.xml")!.async("string")

  // (a) image part byte-identical
  const imgBefore = await original.file("word/media/image1.png")!.async("uint8array")
  const imgAfter = await out.file("word/media/image1.png")!.async("uint8array")
  expect(Array.from(imgAfter)).toEqual(Array.from(imgBefore))
  // (b) every non-document.xml part byte-identical
  for (const name of Object.keys(original.files)) {
    if (name === "word/document.xml" || original.files[name].dir) continue
    expect(await out.file(name)!.async("string")).toBe(await original.file(name)!.async("string"))
  }
  // (c) table + list markup intact, and their text untouched
  expect(xml).toContain("<w:tbl>")
  expect(xml).toContain("<w:numPr>")
  expect(xml).toContain("Cell A"); expect(xml).toContain("Cell B")
  expect(xml).toContain("First item"); expect(xml).toContain("Second item")
  // (d) untranslated list-item paragraph byte-identical (extract from original, assert verbatim)
  const item1 = originalXml.match(/<w:p>(?:(?!<\/w:p>)[\s\S])*First item[\s\S]*?<\/w:p>/)![0]
  expect(xml).toContain(item1)
  // (e) heading translated; XML declaration unchanged (no whole-doc reserialize)
  expect(xml).toContain("Titre")
  expect(xml.slice(0, 60)).toBe(originalXml.slice(0, 60))
  // (f) translator's bold honored on the mixed paragraph; source "the " stays plain
  expect(xml).toMatch(/<w:r><w:rPr>(?:(?!<\/w:rPr>).)*<w:b\/>[^]*?<w:t[^>]*>SEIGNEUR<\/w:t>/)
})
