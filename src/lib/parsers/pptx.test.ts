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

  it("classifies title placeholders as structural headings", async () => {
    const buffer = await makePptx({
      "slide1.xml": `
        <p:sp>
          <p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
          <p:txBody><a:p><a:r><a:t>Presentation title</a:t></a:r></a:p></p:txBody>
        </p:sp>
      `,
    })
    const result = await extractPptxStrings(buffer)
    expect(result[0].type).toBe("heading")
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

  // AQU-1124: table text used to be dropped on the floor — the walk only
  // visited p:sp shapes, and a PowerPoint table lives in a p:graphicFrame.
  describe("tables (AQU-1124)", () => {
    it("extracts text from table cells", async () => {
      const buffer = await makePptx({
        "slide1.xml": `
          <p:graphicFrame><a:graphic><a:graphicData><a:tbl>
            <a:tr>
              <a:tc><a:txBody><a:p><a:r><a:t>Book</a:t></a:r></a:p></a:txBody></a:tc>
              <a:tc><a:txBody><a:p><a:r><a:t>Chapters</a:t></a:r></a:p></a:txBody></a:tc>
            </a:tr>
            <a:tr>
              <a:tc><a:txBody><a:p><a:r><a:t>Genesis</a:t></a:r></a:p></a:txBody></a:tc>
              <a:tc><a:txBody><a:p><a:r><a:t>50</a:t></a:r></a:p></a:txBody></a:tc>
            </a:tr>
          </a:tbl></a:graphicData></a:graphic></p:graphicFrame>
        `,
      })
      const result = await extractPptxStrings(buffer)
      expect(result.map((r) => r.original)).toEqual(["Book", "Chapters", "Genesis", "50"])
      expect(result.every((r) => r.context === "Slide 1")).toBe(true)
    })

    it("gives table cells row/column source locations", async () => {
      const buffer = await makePptx({
        "slide1.xml": `
          <p:graphicFrame><a:graphic><a:graphicData><a:tbl>
            <a:tr>
              <a:tc><a:txBody><a:p><a:r><a:t>R1C1</a:t></a:r></a:p></a:txBody></a:tc>
              <a:tc><a:txBody><a:p><a:r><a:t>R1C2</a:t></a:r></a:p></a:txBody></a:tc>
            </a:tr>
          </a:tbl></a:graphicData></a:graphic></p:graphicFrame>
        `,
      })
      const result = await extractPptxStrings(buffer)
      expect(result[0].sourceLocation).toEqual({
        file: "ppt/slides/slide1.xml",
        blockPath: "p:graphicFrame[1]/a:tbl/a:tr[1]/a:tc[1]/a:txBody/a:p[1]",
      })
      expect(result[1].sourceLocation).toEqual({
        file: "ppt/slides/slide1.xml",
        blockPath: "p:graphicFrame[1]/a:tbl/a:tr[1]/a:tc[2]/a:txBody/a:p[1]",
      })
    })

    it("interleaves table and shape text in slide order, and leaves p:sp numbering alone", async () => {
      const buffer = await makePptx({
        "slide1.xml": `
          <p:sp>
            <p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
            <p:txBody><a:p><a:r><a:t>Overview</a:t></a:r></a:p></p:txBody>
          </p:sp>
          <p:graphicFrame><a:graphic><a:graphicData><a:tbl>
            <a:tr><a:tc><a:txBody><a:p><a:r><a:t>In the table</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
          </a:tbl></a:graphicData></a:graphic></p:graphicFrame>
          <p:sp><p:txBody><a:p><a:r><a:t>After the table</a:t></a:r></a:p></p:txBody></p:sp>
        `,
      })
      const result = await extractPptxStrings(buffer)
      expect(result.map((r) => r.original)).toEqual(["Overview", "In the table", "After the table"])
      expect(result[0].type).toBe("heading")
      // The trailing shape is still p:sp[2] — the table does not renumber it,
      // so locators recorded before table support keep pointing at the same
      // paragraph.
      expect(result[2].sourceLocation?.blockPath).toBe("p:sp[2]/p:txBody/a:p[1]")
    })

    it("ignores a graphic frame that holds no table (chart / SmartArt)", async () => {
      const buffer = await makePptx({
        "slide1.xml": `
          <p:graphicFrame><a:graphic><a:graphicData/></a:graphic></p:graphicFrame>
          <p:sp><p:txBody><a:p><a:r><a:t>Only text</a:t></a:r></a:p></p:txBody></p:sp>
        `,
      })
      const result = await extractPptxStrings(buffer)
      expect(result.map((r) => r.original)).toEqual(["Only text"])
    })
  })
})
