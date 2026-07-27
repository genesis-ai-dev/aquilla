import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { buildFootnoteInstruction, prepareFootnotesForPrompt } from "./completion"
import { createUsfmFootnoteMarker } from "./insert"
import { extractDocxStrings } from "@/lib/parsers/docx"

describe("prepareFootnotesForPrompt (AQU-662)", () => {
  it("returns the source unchanged when there are no footnotes", () => {
    const src = "Just an ordinary source line."
    const out = prepareFootnotesForPrompt(src)
    expect(out.footnoteCount).toBe(0)
    expect(out.promptSource).toBe(src)
    expect(out.footnoteBlock).toBe("")
    expect(out.notes).toEqual([])
  })

  it("does not leak raw \\f...\\f* markup into the model-facing source", () => {
    const src = `In the beginning${createUsfmFootnoteMarker({ text: "Or: at the start" })} God created.`
    const out = prepareFootnotesForPrompt(src)
    expect(out.footnoteCount).toBe(1)
    expect(out.promptSource).not.toContain("\\f")
    expect(out.promptSource).not.toContain("\\ft")
    expect(out.footnoteBlock).not.toContain("\\f")
  })

  it("replaces each footnote span with a positional [n] caller — and nothing else — in the base text", () => {
    const src =
      `Alpha${createUsfmFootnoteMarker({ text: "first note" })} beta` +
      `${createUsfmFootnoteMarker({ text: "second note" })} gamma.`
    const out = prepareFootnotesForPrompt(src)
    expect(out.footnoteCount).toBe(2)
    // The prompt source is EXACTLY the base text with callers: no instruction
    // prose, no footnote entries. Those riding inside the `Source:` payload is
    // what contradicted the system prompt's "final source line only" rule and
    // made models return an empty completion (the "Saved but empty" bug).
    expect(out.promptSource).toBe("Alpha[1] beta[2] gamma.")
  })

  it("presents each footnote as separately translatable content in the footnote block", () => {
    const src = `Text${createUsfmFootnoteMarker({ ref: "1:1", text: "explanatory note" })}.`
    const out = prepareFootnotesForPrompt(src)
    expect(out.promptSource).toBe("Text[1].")
    expect(out.footnoteBlock).toContain("[1]")
    expect(out.footnoteBlock).toContain("(1:1)")
    expect(out.footnoteBlock).toContain("explanatory note")
    expect(out.notes).toHaveLength(1)
    expect(out.notes[0].ref).toBe("1:1")
    expect(out.notes[0].text).toBe("explanatory note")
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
    expect(out.promptSource).toContain("[1]")
    // The note prose is context, not source: it lives in the footnote block.
    expect(out.promptSource).not.toContain("A translatable footnote.")
    expect(out.footnoteBlock).toContain("A translatable footnote.")
  })
})

describe("buildFootnoteInstruction", () => {
  it("names the marker range and the [n]-line output contract", () => {
    const one = buildFootnoteInstruction(1)
    expect(one).toContain("[1]")
    const three = buildFootnoteInstruction(3)
    expect(three).toContain("[1] through [3]")
    expect(three).toContain("one line per footnote")
  })

  it("is placeholder-free so it composes with custom system prompts", () => {
    expect(buildFootnoteInstruction(2)).not.toMatch(/\{[a-zA-Z]+\}/)
  })
})
