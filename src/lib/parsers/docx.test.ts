import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { docxPartsToStrings, extractDocxStrings } from "./docx"
import { extractUsfmFootnotes } from "@/lib/footnotes/extract"

function makeDocx(bodyXml: string, footnotesXml?: string): Promise<ArrayBuffer> {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${bodyXml}</w:body>
</w:document>`

  const zip = new JSZip()
  zip.file("word/document.xml", xml)
  if (footnotesXml !== undefined) {
    zip.file(
      "word/footnotes.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${footnotesXml}</w:footnotes>`,
    )
  }
  return zip.generateAsync({ type: "arraybuffer" })
}

/** A footnote-reference run as Word writes it in word/document.xml. */
function footnoteRef(id: number): string {
  return `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`
}

/** A footnote body entry as Word writes it in word/footnotes.xml. */
function footnoteBody(id: number, text: string): string {
  return `<w:footnote w:id="${id}"><w:p><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> ${text}</w:t></w:r></w:p></w:footnote>`
}

/** The standard separator notes Word always ships (ids -1, 0) — must be ignored. */
const SEPARATOR_NOTES =
  `<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>` +
  `<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>`

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

  it("treats the Word Title style as structural heading content", async () => {
    const buffer = await makeDocx(`
      <w:p>
        <w:pPr><w:pStyle w:val="Title"/></w:pPr>
        <w:r><w:t>Document Title</w:t></w:r>
      </w:p>
    `)
    const result = await extractDocxStrings(buffer)
    expect(result[0].context).toBe("Title")
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

  // AQU-1719: a Google Docs export writes an explicit off flag for every toggle
  // on every run. Reading presence alone marked unformatted source text as
  // struck/underlined/bold/italic.
  it("treats explicit off toggles (w:val=\"0\") as unformatted", async () => {
    const buffer = await makeDocx(`
      <w:p>
        <w:r>
          <w:rPr>
            <w:b w:val="0"/><w:bCs w:val="0"/>
            <w:i w:val="0"/><w:iCs w:val="0"/>
            <w:strike w:val="0"/>
            <w:u w:val="none"/>
          </w:rPr>
          <w:t>But it impacts everything.</w:t>
        </w:r>
      </w:p>
    `)
    const result = await extractDocxStrings(buffer)
    expect(result[0].original).toBe("But it impacts everything.")
    expect(result[0].originalHtml).toBeUndefined()
  })

  it("treats w:val=\"false\" and w:val=\"off\" as unformatted", async () => {
    const buffer = await makeDocx(`
      <w:p>
        <w:r>
          <w:rPr><w:b w:val="false"/><w:i w:val="off"/></w:rPr>
          <w:t>plain</w:t>
        </w:r>
      </w:p>
    `)
    const result = await extractDocxStrings(buffer)
    expect(result[0].originalHtml).toBeUndefined()
  })

  it("still honours toggles turned on explicitly (w:val=\"1\")", async () => {
    const buffer = await makeDocx(`
      <w:p>
        <w:r>
          <w:rPr><w:b w:val="1"/><w:u w:val="single"/></w:rPr>
          <w:t>loud</w:t>
        </w:r>
      </w:p>
    `)
    const result = await extractDocxStrings(buffer)
    expect(result[0].originalHtml).toBe("<u><b>loud</b></u>")
  })

  it("keeps the on toggles of a run that also carries off toggles", async () => {
    const buffer = await makeDocx(`
      <w:p>
        <w:r>
          <w:rPr><w:b/><w:i w:val="0"/><w:strike w:val="0"/><w:u w:val="none"/></w:rPr>
          <w:t>bold only</w:t>
        </w:r>
      </w:p>
    `)
    const result = await extractDocxStrings(buffer)
    expect(result[0].originalHtml).toBe("<b>bold only</b>")
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

  it("sets sourceLocation with block path", async () => {
    const buffer = await makeDocx(`
      <w:p><w:r><w:t>First paragraph</w:t></w:r></w:p>
      <w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p>
    `)
    const result = await extractDocxStrings(buffer)
    expect(result).toHaveLength(2)
    expect(result[0].sourceLocation).toEqual({
      file: "word/document.xml",
      blockPath: "w:p[1]",
    })
    expect(result[1].sourceLocation).toEqual({
      file: "word/document.xml",
      blockPath: "w:p[2]",
    })
  })

  describe("footnotes (AQU-662)", () => {
    it("inlines a DOCX footnote as a USFM marker in the imported source", async () => {
      const buffer = await makeDocx(
        `<w:p>
          <w:r><w:t xml:space="preserve">Body text</w:t></w:r>
          ${footnoteRef(2)}
          <w:r><w:t xml:space="preserve"> continues.</w:t></w:r>
        </w:p>`,
        SEPARATOR_NOTES + footnoteBody(2, "The footnote content."),
      )
      const result = await extractDocxStrings(buffer)
      expect(result).toHaveLength(1)
      // The note is anchored where the reference was, not appended at the end.
      expect(result[0].original).toBe("Body text\\f + \\ft The footnote content.\\f* continues.")
    })

    it("makes DOCX footnotes discoverable by the shared USFM footnote extractor", async () => {
      const buffer = await makeDocx(
        `<w:p>
          <w:r><w:t>See note</w:t></w:r>
          ${footnoteRef(1)}
        </w:p>`,
        SEPARATOR_NOTES + footnoteBody(1, "Clarifying remark."),
      )
      const [cell] = await extractDocxStrings(buffer)
      const notes = extractUsfmFootnotes(cell.original)
      expect(notes).toHaveLength(1)
      expect(notes[0].text).toBe("Clarifying remark.")
    })

    it("ignores the separator / continuationSeparator notes Word always ships", async () => {
      const buffer = await makeDocx(
        `<w:p><w:r><w:t>Plain paragraph, no real footnotes.</w:t></w:r></w:p>`,
        SEPARATOR_NOTES,
      )
      const [cell] = await extractDocxStrings(buffer)
      expect(cell.original).toBe("Plain paragraph, no real footnotes.")
      expect(cell.original).not.toContain("\\f")
    })

    it("disables the rich-HTML path for footnoted paragraphs so the note is not dropped", async () => {
      const buffer = await makeDocx(
        `<w:p>
          <w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r>
          ${footnoteRef(3)}
        </w:p>`,
        SEPARATOR_NOTES + footnoteBody(3, "Note on the bold word."),
      )
      const [cell] = await extractDocxStrings(buffer)
      expect(cell.originalHtml).toBeUndefined()
      expect(extractUsfmFootnotes(cell.original)).toHaveLength(1)
    })

    it("keeps a footnote marker intact when the paragraph is long enough to be segmented", async () => {
      const long = "Sentence one is here. ".repeat(15) // > 200 chars → forces segmentation
      const buffer = await makeDocx(
        `<w:p>
          <w:r><w:t xml:space="preserve">${long}</w:t></w:r>
          ${footnoteRef(4)}
          <w:r><w:t xml:space="preserve"> tail.</w:t></w:r>
        </w:p>`,
        SEPARATOR_NOTES + footnoteBody(4, "A note with its own. Sentences. Inside."),
      )
      const result = await extractDocxStrings(buffer)
      // Exactly one whole, unbroken footnote survives across the segments.
      const allNotes = result.flatMap((c) => extractUsfmFootnotes(c.original))
      expect(allNotes).toHaveLength(1)
      expect(allNotes[0].text).toBe("A note with its own. Sentences. Inside.")
    })

    it("imports body text normally when no footnotes.xml is present", async () => {
      const buffer = await makeDocx(`<w:p><w:r><w:t>Just body.</w:t></w:r></w:p>`)
      const [cell] = await extractDocxStrings(buffer)
      expect(cell.original).toBe("Just body.")
    })
  })

  // AQU-1499: a real partner .docx (68k-word Arabic book, 882 KB on disk) had
  // 39.5 MB of word/document.xml because Word saved nearly every CHARACTER as
  // its own `<w:r>` with a full `<w:rPr>`. Building the element tree for that
  // costs roughly 19× the XML, so this parser — which also runs inside the
  // 128 MB Worker that serves the Agent API's server-side import — needs a
  // ceiling. The ceiling must sit ABOVE the real-world bloat: that file is
  // valid and has to import.
  describe("bloated run XML (AQU-1499)", () => {
    /** One `<w:r><w:rPr>…` per character, the real file's shape. */
    function bloatedParagraph(text: string): string {
      const rPr = '<w:rPr><w:rFonts w:cs="Arial"/><w:szCs w:val="24"/><w:rtl/></w:rPr>'
      let runs = ""
      for (const ch of text) {
        const t = ch === " " ? '<w:t xml:space="preserve"> </w:t>' : `<w:t>${ch}</w:t>`
        runs += `<w:r>${rPr}${t}</w:r>`
      }
      return `<w:p><w:pPr><w:bidi/></w:pPr>${runs}</w:p>`
    }

    function documentXml(bodyXml: string): string {
      return `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`
    }

    it("parses per-character runs to the same cells as the clean one-run-per-paragraph rebuild", () => {
      const paragraphs = ["هذا كتاب عن الله الحقيقي.", "A second paragraph in Latin script."]

      const bloated = docxPartsToStrings({
        documentXml: documentXml(paragraphs.map(bloatedParagraph).join("")),
      })
      const clean = docxPartsToStrings({
        documentXml: documentXml(
          paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join(""),
        ),
      })

      expect(bloated.map((c) => c.original)).toEqual(paragraphs)
      expect(bloated.map((c) => c.original)).toEqual(clean.map((c) => c.original))
    })

    it("refuses a word/document.xml past the tree-size ceiling with a message naming the size and the fix", () => {
      // 64 M chars is the ceiling; a tree for this would be ~1.2 GB of heap.
      const oversized = documentXml(`<w:p><w:r><w:t>${"a".repeat(65 * 1024 * 1024)}</w:t></w:r></w:p>`)
      expect(() => docxPartsToStrings({ documentXml: oversized })).toThrow(
        /too complex to parse: word\/document\.xml is 65(\.\d)? MB/,
      )
      expect(() => docxPartsToStrings({ documentXml: oversized })).toThrow(/Save As/)
    })
  })
})
