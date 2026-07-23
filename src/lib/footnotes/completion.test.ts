import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { prepareFootnotesForPrompt } from "./completion"
import { createUsfmFootnoteMarker } from "./insert"
import { extractDocxStrings } from "@/lib/parsers/docx"

describe("prepareFootnotesForPrompt (AQU-662)", () => {
  it("returns the source unchanged when there are no footnotes", () => {
    const src = "Just an ordinary source line."
    const out = prepareFootnotesForPrompt(src)
    expect(out.footnoteCount).toBe(0)
    expect(out.promptSource).toBe(src)
  })

  it("does not leak raw \\f...\\f* markup into the model-facing source", () => {
    const src = `In the beginning${createUsfmFootnoteMarker({ text: "Or: at the start" })} God created.`
    const out = prepareFootnotesForPrompt(src)
    expect(out.footnoteCount).toBe(1)
    expect(out.promptSource).not.toContain("\\f")
    expect(out.promptSource).not.toContain("\\ft")
  })

  it("replaces each footnote span with a positional [n] caller in the base text", () => {
    const src =
      `Alpha${createUsfmFootnoteMarker({ text: "first note" })} beta` +
      `${createUsfmFootnoteMarker({ text: "second note" })} gamma.`
    const out = prepareFootnotesForPrompt(src)
    expect(out.footnoteCount).toBe(2)
    // Callers land where the markers were, in order.
    expect(out.promptSource.startsWith("Alpha[1] beta[2] gamma.")).toBe(true)
  })

  it("presents each footnote as separately translatable content", () => {
    const src = `Text${createUsfmFootnoteMarker({ ref: "1:1", text: "explanatory note" })}.`
    const out = prepareFootnotesForPrompt(src)
    expect(out.promptSource).toContain("[1]")
    expect(out.promptSource).toContain("(1:1)")
    expect(out.promptSource).toContain("explanatory note")
  })

  // Cross-boundary contract (AGENTS.md rule 12): a real DOCX import's output
  // must flow cleanly through the completion pre-processor — the footnote that
  // docx.ts inlines is the same one prepareFootnotesForPrompt decomposes.
  it("decomposes footnotes that the DOCX importer actually produces", async () => {
    const zip = new JSZip()
    zip.file(
      "word/document.xml",
      `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
  <w:p>
    <w:r><w:t>Consider this</w:t></w:r>
    <w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r>
    <w:r><w:t xml:space="preserve"> point.</w:t></w:r>
  </w:p>
</w:body></w:document>`,
    )
    zip.file(
      "word/footnotes.xml",
      `<?xml version="1.0"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>
  <w:footnote w:id="1"><w:p><w:r><w:t xml:space="preserve"> A translatable footnote.</w:t></w:r></w:p></w:footnote>
</w:footnotes>`,
    )
    const buffer = await zip.generateAsync({ type: "arraybuffer" })

    const [cell] = await extractDocxStrings(buffer)
    const out = prepareFootnotesForPrompt(cell.original)

    expect(out.footnoteCount).toBe(1)
    expect(out.promptSource).not.toContain("\\f")
    expect(out.promptSource).toContain("A translatable footnote.")
    expect(out.promptSource).toContain("[1]")
  })
})
