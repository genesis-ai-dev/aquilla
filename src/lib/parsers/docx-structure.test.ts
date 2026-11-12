// AQU-2539 — one paragraph scan and one paragraph walk for import and export.
import { describe, it, expect } from "vitest"
import { docxLine, scanDocxParagraphs, walkDocxParagraph } from "./docx-structure"
import { docxPartsToStrings } from "./docx"
import { elementsByTagName, parseXmlLite } from "./xml-lite"
import {
  complexField,
  documentXml,
  footnoteRefRun,
  footnotesXml,
  para,
  pictureRun,
  run,
  textBoxRun,
} from "./__fixtures__/docx-structures"

const lineOf = (xml: string) => {
  const p = elementsByTagName(parseXmlLite(xml), "w:p")[0]
  return docxLine(walkDocxParagraph(p, { footnotes: new Map() }))
}

describe("scanDocxParagraphs", () => {
  it("numbers nested paragraphs in document order, exactly like the XML tree", () => {
    const xml = documentXml(
      para(run("Before")) +
        para(run("Holder ") + textBoxRun(para(run("Box line one")) + para(run("Box line two")))) +
        `<w:p/>` +
        para(run("After")),
    )
    const spans = scanDocxParagraphs(xml)
    const tree = elementsByTagName(parseXmlLite(xml), "w:p")
    expect(spans).toHaveLength(tree.length)
    expect(spans.map((s) => s.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    // Holder (2) holds the Choice copies (3, 4) and the Fallback copies (5, 6).
    expect(spans.map((s) => s.parent)).toEqual([0, 0, 2, 2, 2, 2, 0, 0])
    expect(spans.map((s) => s.isCopy)).toEqual([false, false, false, false, true, true, false, false])
    expect(spans.map((s) => s.copyOf)).toEqual([0, 0, 0, 0, 3, 4, 0, 0])
    // Offsets cut out exactly one element each, nested ones included.
    expect(xml.slice(spans[2].start, spans[2].end)).toBe(para(run("Box line one")))
    expect(xml.slice(spans[6].start, spans[6].end)).toBe("<w:p/>")
    expect(spans[6].selfClosing).toBe(true)
  })

  it("does not count a w:p inside a comment, CDATA or processing instruction", () => {
    const xml = documentXml(
      `<!-- <w:p>not a paragraph</w:p> --><?pi <w:p> ?>` + para(run("<![CDATA[x]]>")) + para(run("Real")),
    )
    expect(scanDocxParagraphs(xml)).toHaveLength(elementsByTagName(parseXmlLite(xml), "w:p").length)
  })

  it("pairs no copy when the branches do not hold the same number of paragraphs", () => {
    const xml = documentXml(
      para(
        `<w:r><mc:AlternateContent><mc:Choice Requires="wps">${para(run("A"))}${para(run("B"))}</mc:Choice>` +
          `<mc:Fallback>${para(run("A"))}</mc:Fallback></mc:AlternateContent></w:r>`,
      ),
    )
    const spans = scanDocxParagraphs(xml)
    expect(spans.map((s) => [s.isCopy, s.copyOf])).toEqual([[false, 0], [false, 0], [false, 0], [true, 0]])
  })
})

describe("walkDocxParagraph / docxLine", () => {
  it("reads only the paragraph's own words, never a text box's", () => {
    const line = lineOf(documentXml(para(run("Holder ") + textBoxRun(para(run("Inside"))) + run("text"))))
    expect(line.text).toBe("Holder text")
  })

  it("carries tabs and line breaks between words, and leaves edge ones out", () => {
    const line = lineOf(
      documentXml(para(`<w:r><w:tab/><w:t>ASV</w:t><w:tab/><w:t>American</w:t><w:br/><w:t>Standard</w:t><w:tab/></w:r>`)),
    )
    expect(line.text).toBe("ASV\tAmerican\nStandard")
  })

  it("treats page and column breaks, pictures and field codes as not text", () => {
    const line = lineOf(
      documentXml(
        para(
          `<w:r><w:br w:type="page"/></w:r>` + pictureRun + run("Figure ") + complexField("SEQ Figure", "1") + run(": caption"),
        ),
      ),
    )
    expect(line.text).toBe("Figure 1: caption")
    expect(line.hasWords).toBe(true)
  })

  it("has no words when the paragraph is only a picture", () => {
    expect(lineOf(documentXml(para(pictureRun))).hasWords).toBe(false)
  })
})

describe("docxPartsToStrings (AQU-2539)", () => {
  const cells = (body: string, footnotes?: string) =>
    docxPartsToStrings({ documentXml: documentXml(body), ...(footnotes ? { footnotesXml: footnotes } : {}) })

  it("makes a text box's paragraph its own line, once, at its own w:p[N]", () => {
    const strings = cells(
      para(run("Holder")) +
        para(textBoxRun(para(run("Figure 1: Caption"), "Caption")) + pictureRun, "Caption") +
        para(run("After")),
    )
    expect(strings.map((s) => [s.original, s.sourceLocation?.blockPath, s.context])).toEqual([
      ["Holder", "w:p[1]", "Paragraph"],
      // w:p[2] holds only the box and a picture: no words of its own, no line.
      ["Figure 1: Caption", "w:p[3]", "Caption"],
      // w:p[4] is the Fallback copy of w:p[3]: no second line.
      ["After", "w:p[5]", "Paragraph"],
    ])
  })

  it("reads a paragraph's style from its own pPr, not a text box's", () => {
    const strings = cells(para(run("Outer ") + textBoxRun(para(run("In box"), "Caption"))))
    expect(strings.find((s) => s.original.startsWith("Outer"))?.context).toBe("Paragraph")
  })

  it("keeps tabs and line breaks inside long paragraphs that are split into several lines", () => {
    const long = "word ".repeat(50).trim()
    const strings = cells(para(`<w:r><w:t>Key</w:t><w:tab/><w:t xml:space="preserve">${long}. ${long}</w:t><w:br/><w:t>End.</w:t></w:r>`))
    expect(strings.length).toBeGreaterThan(1)
    const joined = strings.map((s) => s.original).join(" ")
    expect(joined.startsWith("Key\tword")).toBe(true)
    expect(joined).toContain("\nEnd.")
  })

  it("still inlines a footnote as a USFM marker at its place", () => {
    const strings = cells(para(run("Text") + footnoteRefRun(2) + run(" more.")), footnotesXml({ 2: "The note." }))
    expect(strings[0].original).toBe("Text\\f + \\ft The note.\\f* more.")
  })
})

describe("hidden text (AQU-2539)", () => {
  const V = "<w:rPr><w:vanish/></w:rPr>"
  const styles = (inner: string, defaults = "") =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:docDefaults><w:rPrDefault><w:rPr>${defaults}</w:rPr></w:rPrDefault></w:docDefaults>${inner}</w:styles>`
  const lines = (body: string, stylesXml?: string) =>
    docxPartsToStrings({ documentXml: documentXml(body), ...(stylesXml ? { stylesXml } : {}) }).map((s) => [
      s.sourceLocation?.blockPath,
      s.original,
    ])

  it("leaves hidden runs out of the line, and a wholly hidden paragraph makes no line", () => {
    expect(lines(para(run("Shown ") + run("hidden ", V) + run("too")) + para(run("All hidden", V)) + para(run("Next")))).toEqual([
      ["w:p[1]", "Shown too"],
      // w:p[2] still counts: numbering does not change, old locators resolve.
      ["w:p[3]", "Next"],
    ])
  })

  it("honours w:val=\"0\" as not hidden", () => {
    expect(lines(para(run("Visible", '<w:rPr><w:vanish w:val="0"/></w:rPr>')))).toEqual([["w:p[1]", "Visible"]])
  })

  it("follows hidden text through a character style and its basedOn chain", () => {
    const sheet = styles(
      `<w:style w:type="character" w:styleId="Base"><w:rPr><w:vanish/></w:rPr></w:style>` +
        `<w:style w:type="character" w:styleId="Derived"><w:basedOn w:val="Base"/></w:style>`,
    )
    expect(lines(para(run("a ") + run("secret ", '<w:rPr><w:rStyle w:val="Derived"/></w:rPr>') + run("b")), sheet)).toEqual([
      ["w:p[1]", "a b"],
    ])
  })

  it("follows hidden text through the paragraph's style, and through the default paragraph style", () => {
    const sheet = styles(
      `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"/>` +
        `<w:style w:type="paragraph" w:styleId="NotForTranslation"><w:basedOn w:val="Normal"/><w:rPr><w:vanish/></w:rPr></w:style>`,
    )
    expect(lines(para(run("Bibliography entry"), "NotForTranslation") + para(run("Body")), sheet)).toEqual([["w:p[2]", "Body"]])
    const hiddenNormal = styles(`<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:rPr><w:vanish/></w:rPr></w:style>`)
    expect(lines(para(run("Unstyled")), hiddenNormal)).toEqual([])
  })

  it("uses the document defaults only when no style says anything, and lets a run override them", () => {
    const sheet = styles("", "<w:vanish/>")
    expect(lines(para(run("Default hidden")) + para(run("Shown", '<w:rPr><w:vanish w:val="false"/></w:rPr>')), sheet)).toEqual([
      ["w:p[2]", "Shown"],
    ])
  })

  it("combines a hidden character style and a hidden paragraph style as Word does (they cancel)", () => {
    const sheet = styles(
      `<w:style w:type="paragraph" w:styleId="P"><w:rPr><w:vanish/></w:rPr></w:style>` +
        `<w:style w:type="character" w:styleId="C"><w:rPr><w:vanish/></w:rPr></w:style>`,
    )
    expect(lines(para(run("x", '<w:rPr><w:rStyle w:val="C"/></w:rPr>'), "P"), sheet)).toEqual([["w:p[1]", "x"]])
  })
})
