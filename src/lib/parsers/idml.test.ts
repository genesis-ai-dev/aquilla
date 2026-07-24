import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { extractIdmlStrings } from "./idml"

const IDPKG = 'xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging"'

function storyXml(inner: string, self = "u100"): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Story ${IDPKG} DOMVersion="18.0">
  <Story Self="${self}">${inner}</Story>
</idPkg:Story>`
}

function designmapXml(storySrcs: string[]): string {
  const stories = storySrcs.map((src) => `<idPkg:Story src="${src}"/>`).join("\n  ")
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Document ${IDPKG} DOMVersion="18.0" Self="d">
  ${stories}
</Document>`
}

function psr(inner: string, style = "ParagraphStyle/$ID/NormalParagraphStyle"): string {
  return `<ParagraphStyleRange AppliedParagraphStyle="${style}">${inner}</ParagraphStyleRange>`
}

function csr(inner: string, attrs = ""): string {
  return `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"${attrs ? ` ${attrs}` : ""}>${inner}</CharacterStyleRange>`
}

async function makeIdml(stories: Record<string, string>): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("mimetype", "application/vnd.adobe.indesign-idml-package")
  zip.file("designmap.xml", designmapXml(Object.keys(stories)))
  for (const [src, inner] of Object.entries(stories)) {
    zip.file(src, storyXml(inner))
  }
  return zip.generateAsync({ type: "arraybuffer" })
}

describe("extractIdmlStrings", () => {
  it("extracts plain paragraph text", async () => {
    const buffer = await makeIdml({
      "Stories/Story_u100.xml": psr(csr("<Content>Hello world</Content>")),
    })
    const result = await extractIdmlStrings(buffer)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("Hello world")
    expect(result[0].context).toBe("Paragraph")
    expect(result[0].type).toBe("text")
    expect(result[0].translated).toBe("")
    expect(result[0].paragraphStart).toBe(true)
  })

  it("detects heading styles and uses the style leaf as context", async () => {
    const buffer = await makeIdml({
      "Stories/Story_u100.xml": psr(
        csr("<Content>Chapter One</Content>"),
        "ParagraphStyle/Heading 1",
      ),
    })
    const result = await extractIdmlStrings(buffer)
    expect(result[0].context).toBe("Heading 1")
    expect(result[0].type).toBe("heading")
  })

  it("decodes percent-encoded style names", async () => {
    const buffer = await makeIdml({
      "Stories/Story_u100.xml": psr(
        csr("<Content>Intro</Content>"),
        "ParagraphStyle/Body%3aFirst",
      ),
    })
    const result = await extractIdmlStrings(buffer)
    expect(result[0].context).toBe("Body:First")
  })

  it("concatenates character ranges and captures formatting as originalHtml", async () => {
    const buffer = await makeIdml({
      "Stories/Story_u100.xml": psr(
        csr("<Content>Normal </Content>")
        + csr("<Content>bold</Content>", 'FontStyle="Bold"')
        + csr("<Content> text</Content>"),
      ),
    })
    const result = await extractIdmlStrings(buffer)
    expect(result[0].original).toBe("Normal bold text")
    expect(result[0].originalHtml).toBe("Normal <b>bold</b> text")
  })

  it("maps italic FontStyle and Underline attribute", async () => {
    const buffer = await makeIdml({
      "Stories/Story_u100.xml": psr(
        csr("<Content>italic</Content>", 'FontStyle="Italic"')
        + csr("<Content>under</Content>", 'Underline="true"'),
      ),
    })
    const result = await extractIdmlStrings(buffer)
    expect(result[0].originalHtml).toBe("<i>italic</i><u>under</u>")
  })

  it("turns an inner <Br/> into a newline and drops the trailing one", async () => {
    const buffer = await makeIdml({
      "Stories/Story_u100.xml": psr(
        csr("<Content>line one</Content><Br/><Content>line two</Content><Br/>"),
      ),
    })
    const result = await extractIdmlStrings(buffer)
    expect(result[0].original).toBe("line one\nline two")
  })

  it("skips empty paragraphs but keeps blockPath indices aligned", async () => {
    const buffer = await makeIdml({
      "Stories/Story_u100.xml":
        psr(csr("<Content>First</Content>"))
        + psr(csr("<Br/>"))
        + psr(csr("<Content>Third</Content>")),
    })
    const result = await extractIdmlStrings(buffer)
    expect(result).toHaveLength(2)
    expect(result[0].sourceLocation).toEqual({
      file: "Stories/Story_u100.xml",
      blockPath: "ParagraphStyleRange[1]",
    })
    expect(result[1].sourceLocation).toEqual({
      file: "Stories/Story_u100.xml",
      blockPath: "ParagraphStyleRange[3]",
    })
  })

  it("orders stories by designmap, not by zip entry name", async () => {
    const zip = new JSZip()
    zip.file("mimetype", "application/vnd.adobe.indesign-idml-package")
    zip.file("designmap.xml", designmapXml([
      "Stories/Story_u900.xml",
      "Stories/Story_u100.xml",
    ]))
    zip.file("Stories/Story_u100.xml", storyXml(psr(csr("<Content>Second</Content>"))))
    zip.file("Stories/Story_u900.xml", storyXml(psr(csr("<Content>First</Content>")), "u900"))
    const buffer = await zip.generateAsync({ type: "arraybuffer" })

    const result = await extractIdmlStrings(buffer)
    expect(result.map((s) => s.original)).toEqual(["First", "Second"])
  })

  it("still imports stories the designmap does not reference", async () => {
    const zip = new JSZip()
    zip.file("designmap.xml", designmapXml(["Stories/Story_u100.xml"]))
    zip.file("Stories/Story_u100.xml", storyXml(psr(csr("<Content>Listed</Content>"))))
    zip.file("Stories/Story_u200.xml", storyXml(psr(csr("<Content>Orphan</Content>")), "u200"))
    const buffer = await zip.generateAsync({ type: "arraybuffer" })

    const result = await extractIdmlStrings(buffer)
    expect(result.map((s) => s.original)).toEqual(["Listed", "Orphan"])
  })

  it("skips footnote paragraphs nested inside a paragraph", async () => {
    const footnote = `<Footnote>${psr(csr("<Content>Footnote text</Content>"))}</Footnote>`
    const buffer = await makeIdml({
      "Stories/Story_u100.xml": psr(
        csr(`<Content>Body text</Content>${footnote}`),
      ),
    })
    const result = await extractIdmlStrings(buffer)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("Body text")
  })

  it("splits long paragraphs into segments sharing one sourceLocation", async () => {
    const sentence = "This sentence is repeated to exceed the segment limit. "
    const buffer = await makeIdml({
      "Stories/Story_u100.xml": psr(csr(`<Content>${sentence.repeat(8).trim()}</Content>`)),
    })
    const result = await extractIdmlStrings(buffer)
    expect(result.length).toBeGreaterThan(1)
    const groups = new Set(result.map((s) => s.group))
    expect(groups.size).toBe(1)
    for (const s of result) {
      expect(s.sourceLocation).toEqual({
        file: "Stories/Story_u100.xml",
        blockPath: "ParagraphStyleRange[1]",
      })
    }
    expect(result[0].paragraphStart).toBe(true)
    expect(result[1].paragraphStart).toBeUndefined()
  })

  it("throws on an archive without stories", async () => {
    const zip = new JSZip()
    zip.file("designmap.xml", designmapXml([]))
    const buffer = await zip.generateAsync({ type: "arraybuffer" })
    await expect(extractIdmlStrings(buffer)).rejects.toThrow(/does not contain any stories/)
  })

  it("rejects an empty file", async () => {
    await expect(extractIdmlStrings(new ArrayBuffer(0))).rejects.toThrow(/empty/)
  })
})
