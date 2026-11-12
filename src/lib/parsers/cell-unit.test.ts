// AQU-1720 regression guard: `cellUnit: "paragraph"` makes the paragraph the
// cell for docx/txt/md imports.
//
// A dubbing/podcast project generates one voice clip per cell, so a cell cut at
// a comma is an unusable clip. These tests pin the two things that made that
// happen before — the sentence split and the 200-character length cap — and the
// fact that neither applies in paragraph mode, while sentence mode is unchanged.

import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { docxPartsToStrings, extractDocxStrings } from "./docx"
import { extractPlaintextStrings } from "./plaintext"
import { extractMarkdownStrings } from "./markdown"
import { parseTextFormat } from "./parse-text-formats"
import { splitIntoSegments } from "./text-splitter"

/** A transcript paragraph of the shape the LOTE import produced fragments from:
 *  well over the 200-char cap, with the commas that the splitter cut at. */
const LONG_PARAGRAPH =
  "How you view yourself, and how you view God, and how you view the people around you " +
  "is the thing that changes everything, because it is an experiment that someone said " +
  "could never work, and yet every one of these sessions has shown otherwise, over and " +
  "over again, for a year and more."

function paragraphXml(text: string): string {
  return `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
}

function makeDocxParts(bodyXml: string) {
  return {
    documentXml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${bodyXml}</w:body>
</w:document>`,
  }
}

describe("splitIntoSegments — cellUnit", () => {
  it("never splits in paragraph mode, however long the text", () => {
    expect(LONG_PARAGRAPH.length).toBeGreaterThan(200)
    const segments = splitIntoSegments(LONG_PARAGRAPH, undefined, "paragraph")
    expect(segments).toHaveLength(1)
    expect(segments[0].text).toBe(LONG_PARAGRAPH)
  })

  it("still splits in sentence mode (the default)", () => {
    expect(splitIntoSegments(LONG_PARAGRAPH).length).toBeGreaterThan(1)
    expect(splitIntoSegments(LONG_PARAGRAPH, undefined, "sentence").length).toBeGreaterThan(1)
  })
})

describe("docx — cellUnit: paragraph", () => {
  it("emits exactly one cell per w:p, with no fragment cut at a comma", () => {
    const parts = makeDocxParts(
      [paragraphXml(LONG_PARAGRAPH), paragraphXml(LONG_PARAGRAPH), paragraphXml("Short block.")].join(""),
    )

    const sentence = docxPartsToStrings(parts)
    const paragraph = docxPartsToStrings(parts, { cellUnit: "paragraph" })

    // The bug: 3 paragraphs became more than 3 cells, some ending mid-sentence.
    expect(sentence.length).toBeGreaterThan(3)
    expect(sentence.some((cell) => cell.original.trimEnd().endsWith(","))).toBe(true)

    expect(paragraph).toHaveLength(3)
    expect(paragraph[0].original).toBe(LONG_PARAGRAPH)
    expect(paragraph[1].original).toBe(LONG_PARAGRAPH)
    expect(paragraph[2].original).toBe("Short block.")
    expect(paragraph.some((cell) => cell.original.trimEnd().endsWith(","))).toBe(false)
  })

  it("marks every paragraph-mode cell as a paragraph start", () => {
    const cells = docxPartsToStrings(
      makeDocxParts([paragraphXml(LONG_PARAGRAPH), paragraphXml(LONG_PARAGRAPH)].join("")),
      { cellUnit: "paragraph" },
    )
    expect(cells.every((cell) => cell.paragraphStart === true)).toBe(true)
  })

  it("skips empty paragraphs", () => {
    const cells = docxPartsToStrings(
      makeDocxParts([paragraphXml("First."), "<w:p/>", paragraphXml("   "), paragraphXml("Second.")].join("")),
      { cellUnit: "paragraph" },
    )
    expect(cells.map((cell) => cell.original)).toEqual(["First.", "Second."])
  })

  it("keeps a footnote span whole inside its paragraph", async () => {
    const zip = new JSZip()
    zip.file(
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${LONG_PARAGRAPH}</w:t></w:r><w:r><w:footnoteReference w:id="2"/></w:r></w:p></w:body>
</w:document>`,
    )
    zip.file(
      "word/footnotes.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="2"><w:p><w:r><w:t>A note.</w:t></w:r></w:p></w:footnote></w:footnotes>`,
    )
    const buffer = await zip.generateAsync({ type: "arraybuffer" })

    const cells = await extractDocxStrings(buffer, { cellUnit: "paragraph" })
    expect(cells).toHaveLength(1)
    expect(cells[0].original).toContain("A note.")
    expect(cells[0].original.startsWith(LONG_PARAGRAPH)).toBe(true)
  })

  it("defaults to sentence mode when no option is passed", () => {
    const parts = makeDocxParts(paragraphXml(LONG_PARAGRAPH))
    expect(docxPartsToStrings(parts)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "text" })]),
    )
    expect(docxPartsToStrings(parts).length).toBe(docxPartsToStrings(parts, {}).length)
    expect(docxPartsToStrings(parts).length).toBeGreaterThan(1)
  })
})

describe("plaintext — cellUnit: paragraph", () => {
  it("treats every line as a paragraph when the file has no blank lines", () => {
    // The dubbing transcript shape: one paragraph per line, no blank lines.
    const text = [LONG_PARAGRAPH, "Second block, which also runs on.", "Third block."].join("\n")

    const cells = extractPlaintextStrings(text, { cellUnit: "paragraph" })
    expect(cells.map((cell) => cell.original)).toEqual([
      LONG_PARAGRAPH,
      "Second block, which also runs on.",
      "Third block.",
    ])
  })

  it("treats blank lines as the break and rejoins wrapped lines", () => {
    const text = "A wrapped paragraph\nthat continues here.\n\nA second paragraph."

    const cells = extractPlaintextStrings(text, { cellUnit: "paragraph" })
    expect(cells.map((cell) => cell.original)).toEqual([
      "A wrapped paragraph that continues here.",
      "A second paragraph.",
    ])
  })

  it("handles CRLF line endings the same way", () => {
    const cells = extractPlaintextStrings(`${LONG_PARAGRAPH}\r\nSecond block.\r\n`, {
      cellUnit: "paragraph",
    })
    expect(cells.map((cell) => cell.original)).toEqual([LONG_PARAGRAPH, "Second block."])
  })

  it("leaves sentence mode (the default) splitting as before", () => {
    const text = [LONG_PARAGRAPH, "Second block."].join("\n")
    expect(extractPlaintextStrings(text).length).toBeGreaterThan(2)
    expect(extractPlaintextStrings(text, {}).length).toBeGreaterThan(2)
  })
})

describe("markdown — cellUnit: paragraph", () => {
  it("emits one cell per block with no sentence split", () => {
    const md = `# A heading\n\n${LONG_PARAGRAPH}\n\nAnother block.`

    const cells = extractMarkdownStrings(md, { cellUnit: "paragraph" })
    expect(cells.map((cell) => cell.original)).toEqual([
      "A heading",
      LONG_PARAGRAPH,
      "Another block.",
    ])
    expect(extractMarkdownStrings(md).length).toBeGreaterThan(3)
  })
})

describe("parseTextFormat — cellUnit passthrough", () => {
  it("forwards the option to txt and md", () => {
    const txt = parseTextFormat({
      fileType: "txt",
      text: LONG_PARAGRAPH,
      name: "a.txt",
      cellUnit: "paragraph",
    })
    expect(txt[0].strings).toHaveLength(1)

    const md = parseTextFormat({
      fileType: "md",
      text: LONG_PARAGRAPH,
      name: "a.md",
      cellUnit: "paragraph",
    })
    expect(md[0].strings).toHaveLength(1)
  })

  it("segments as before when the option is absent", () => {
    const txt = parseTextFormat({ fileType: "txt", text: LONG_PARAGRAPH, name: "a.txt" })
    expect(txt[0].strings.length).toBeGreaterThan(1)
  })

  it("leaves formats that define their own cells alone", () => {
    // A subtitle cue is a cue whatever the cell unit says — the format owns it.
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n" + LONG_PARAGRAPH + "\n"
    const withOption = parseTextFormat({
      fileType: "vtt",
      text: vtt,
      name: "a.vtt",
      cellUnit: "paragraph",
    })
    const without = parseTextFormat({ fileType: "vtt", text: vtt, name: "a.vtt" })
    // Ignore the per-run uuids (id/group); the cue text, timings and type are
    // what the option must not touch.
    const shape = (strings: typeof withOption[number]["strings"]) =>
      strings.map(({ original, type, start, end }) => ({ original, type, start, end }))
    expect(shape(withOption[0].strings)).toEqual(shape(without[0].strings))
    expect(withOption[0].strings).toHaveLength(1)
    expect(withOption[0].strings[0].original).toBe(LONG_PARAGRAPH)
  })
})
