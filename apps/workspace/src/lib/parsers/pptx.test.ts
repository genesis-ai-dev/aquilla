import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { extractPptxStrings } from "./pptx"

function makePptx(slides: Record<string, string>): Promise<ArrayBuffer> {
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

describe("extractPptxStrings", () => {
  it("extracts text from a single slide", async () => {
    const buffer = await makePptx({
      "slide1.xml": `
        <p:sp><p:txBody>
          <a:p><a:r><a:t>Hello slide</a:t></a:r></a:p>
        </p:txBody></p:sp>
      `,
    })
    const result = await extractPptxStrings(buffer)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("Hello slide")
    expect(result[0].context).toBe("Slide 1")
    expect(result[0].type).toBe("text")
  })

  it("extracts from multiple slides in order", async () => {
    const buffer = await makePptx({
      "slide1.xml": `
        <p:sp><p:txBody>
          <a:p><a:r><a:t>Slide one</a:t></a:r></a:p>
        </p:txBody></p:sp>
      `,
      "slide2.xml": `
        <p:sp><p:txBody>
          <a:p><a:r><a:t>Slide two</a:t></a:r></a:p>
        </p:txBody></p:sp>
      `,
    })
    const result = await extractPptxStrings(buffer)
    expect(result).toHaveLength(2)
    expect(result[0].context).toBe("Slide 1")
    expect(result[1].context).toBe("Slide 2")
  })

  it("extracts bold formatting", async () => {
    const buffer = await makePptx({
      "slide1.xml": `
        <p:sp><p:txBody>
          <a:p>
            <a:r><a:t>Normal </a:t></a:r>
            <a:r><a:rPr b="1"/><a:t>bold</a:t></a:r>
          </a:p>
        </p:txBody></p:sp>
      `,
    })
    const result = await extractPptxStrings(buffer)
    expect(result[0].original).toBe("Normal bold")
    expect(result[0].originalHtml).toBe("Normal <b>bold</b>")
  })

  it("skips empty paragraphs", async () => {
    const buffer = await makePptx({
      "slide1.xml": `
        <p:sp><p:txBody>
          <a:p><a:r><a:t>Text</a:t></a:r></a:p>
          <a:p></a:p>
        </p:txBody></p:sp>
      `,
    })
    const result = await extractPptxStrings(buffer)
    expect(result).toHaveLength(1)
  })

  it("sets translated equal to original", async () => {
    const buffer = await makePptx({
      "slide1.xml": `
        <p:sp><p:txBody>
          <a:p><a:r><a:t>Test</a:t></a:r></a:p>
        </p:txBody></p:sp>
      `,
    })
    const result = await extractPptxStrings(buffer)
    expect(result[0].translated).toBe("")
  })

  it("sets sourceLocation with shape and paragraph path", async () => {
    const buffer = await makePptx({
      "slide1.xml": `
        <p:sp><p:txBody>
          <a:p><a:r><a:t>First para</a:t></a:r></a:p>
          <a:p><a:r><a:t>Second para</a:t></a:r></a:p>
        </p:txBody></p:sp>
      `,
    })
    const result = await extractPptxStrings(buffer)
    expect(result).toHaveLength(2)
    expect(result[0].sourceLocation).toEqual({
      file: "ppt/slides/slide1.xml",
      blockPath: "p:sp[1]/p:txBody/a:p[1]",
    })
    expect(result[1].sourceLocation).toEqual({
      file: "ppt/slides/slide1.xml",
      blockPath: "p:sp[1]/p:txBody/a:p[2]",
    })
  })
})
