import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { extractDocxStrings } from "./docx"

function makeDocx(bodyXml: string): Promise<ArrayBuffer> {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${bodyXml}</w:body>
</w:document>`

  const zip = new JSZip()
  zip.file("word/document.xml", xml)
  return zip.generateAsync({ type: "arraybuffer" })
}

describe("extractDocxStrings", () => {
  it("extracts plain paragraph text", async () => {
    const buffer = await makeDocx(`
      <w:p>
        <w:r><w:t>Hello world</w:t></w:r>
      </w:p>
    `)
    const result = await extractDocxStrings(buffer)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("Hello world")
    expect(result[0].context).toBe("Paragraph")
    expect(result[0].type).toBe("text")
  })

  it("detects heading styles", async () => {
    const buffer = await makeDocx(`
      <w:p>
        <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
        <w:r><w:t>Chapter Title</w:t></w:r>
      </w:p>
    `)
    const result = await extractDocxStrings(buffer)
    expect(result[0].context).toBe("Heading 1")
    expect(result[0].type).toBe("heading")
  })

  it("extracts bold formatting as originalHtml", async () => {
    const buffer = await makeDocx(`
      <w:p>
        <w:r><w:t>Normal </w:t></w:r>
        <w:r>
          <w:rPr><w:b/></w:rPr>
          <w:t>bold</w:t>
        </w:r>
        <w:r><w:t> text</w:t></w:r>
      </w:p>
    `)
    const result = await extractDocxStrings(buffer)
    expect(result[0].original).toBe("Normal bold text")
    expect(result[0].originalHtml).toBe("Normal <b>bold</b> text")
  })

  it("extracts italic formatting", async () => {
    const buffer = await makeDocx(`
      <w:p>
        <w:r>
          <w:rPr><w:i/></w:rPr>
          <w:t>italic</w:t>
        </w:r>
      </w:p>
    `)
    const result = await extractDocxStrings(buffer)
    expect(result[0].originalHtml).toBe("<i>italic</i>")
  })

  it("concatenates multiple runs", async () => {
    const buffer = await makeDocx(`
      <w:p>
        <w:r><w:t>First </w:t></w:r>
        <w:r><w:t>second</w:t></w:r>
      </w:p>
    `)
    const result = await extractDocxStrings(buffer)
    expect(result[0].original).toBe("First second")
  })

  it("skips empty paragraphs", async () => {
    const buffer = await makeDocx(`
      <w:p><w:r><w:t>Text</w:t></w:r></w:p>
      <w:p></w:p>
    `)
    const result = await extractDocxStrings(buffer)
    expect(result).toHaveLength(1)
  })

  it("sets translated equal to original", async () => {
    const buffer = await makeDocx(`
      <w:p><w:r><w:t>Hello</w:t></w:r></w:p>
    `)
    const result = await extractDocxStrings(buffer)
    expect(result[0].translated).toBe("")
  })
})
