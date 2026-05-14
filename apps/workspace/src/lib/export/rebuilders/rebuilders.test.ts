import { describe, it, expect } from "vitest"
import { rebuildPlaintext } from "./plaintext"
import { rebuildMarkdown } from "./markdown"
import { rebuildVtt, rebuildSrt } from "./subtitle"
import { rebuildUsfm } from "./usfm"
import type { ExportCell } from "@/lib/store/file-doc"

function makeCell(overrides: Partial<ExportCell> & { id: string }): ExportCell {
  return {
    original: "",
    translated: "",
    context: "",
    group: "",
    type: "text",
    ...overrides,
  }
}

describe("rebuildPlaintext", () => {
  it("emits paragraphs separated by double newlines", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", original: "A", translated: "un", context: "Paragraph 1", group: "g1" }),
      makeCell({ id: "c2", original: "B", translated: "deux", context: "Paragraph 2", group: "g2" }),
    ]
    expect(rebuildPlaintext(cells)).toBe("un\n\ndeux")
  })

  it("joins segments in same group with spaces", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", original: "First half.", translated: "Première partie.", context: "Paragraph 1", group: "g1" }),
      makeCell({ id: "c2", original: "Second half.", translated: "Deuxième partie.", context: "Paragraph 1", group: "g1" }),
    ]
    expect(rebuildPlaintext(cells)).toBe("Première partie. Deuxième partie.")
  })

  it("falls back to original when translated is empty", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", original: "Hello", translated: "", context: "Paragraph 1", group: "g1" }),
      makeCell({ id: "c2", original: "World", translated: "Monde", context: "Paragraph 2", group: "g2" }),
    ]
    expect(rebuildPlaintext(cells)).toBe("Hello\n\nMonde")
  })

  it("handles empty input", () => {
    expect(rebuildPlaintext([])).toBe("")
  })
})

describe("rebuildMarkdown", () => {
  it("emits headings with correct level", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", original: "Title", translated: "Titre", context: "Heading 1", group: "g1", type: "heading" }),
      makeCell({ id: "c2", original: "Sub", translated: "Sous", context: "Heading 2", group: "g2", type: "heading" }),
    ]
    expect(rebuildMarkdown(cells)).toBe("# Titre\n\n## Sous")
  })

  it("emits list items with dashes", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", translated: "First", context: "List item", group: "g1", type: "list" }),
      makeCell({ id: "c2", translated: "Second", context: "List item", group: "g2", type: "list" }),
    ]
    expect(rebuildMarkdown(cells)).toBe("- First\n\n- Second")
  })

  it("emits blockquotes with > prefix", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", translated: "A quote", context: "Blockquote", group: "g1", type: "blockquote" }),
    ]
    expect(rebuildMarkdown(cells)).toBe("> A quote")
  })

  it("emits paragraphs plainly", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", translated: "Normal text", context: "Paragraph", group: "g1", type: "text" }),
    ]
    expect(rebuildMarkdown(cells)).toBe("Normal text")
  })

  it("joins segments of same group with spaces within a block", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", translated: "Part one.", context: "Paragraph", group: "g1", type: "text" }),
      makeCell({ id: "c2", translated: "Part two.", context: "Paragraph", group: "g1", type: "text" }),
    ]
    expect(rebuildMarkdown(cells)).toBe("Part one. Part two.")
  })

  it("falls back to original when translated is empty", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", original: "Fallback", translated: "", context: "Paragraph", group: "g1", type: "text" }),
    ]
    expect(rebuildMarkdown(cells)).toBe("Fallback")
  })

  it("mixes heading levels correctly", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", translated: "H1", context: "Heading 1", group: "g1", type: "heading" }),
      makeCell({ id: "c2", translated: "Para", context: "Paragraph", group: "g2", type: "text" }),
      makeCell({ id: "c3", translated: "H3", context: "Heading 3", group: "g3", type: "heading" }),
    ]
    expect(rebuildMarkdown(cells)).toBe("# H1\n\nPara\n\n### H3")
  })

  it("preserves bold/italic/code from translatedHtml as markdown", () => {
    const cells: ExportCell[] = [
      makeCell({
        id: "c1",
        translated: "This is bold and italic and code",
        translatedHtml: "<p>This is <b>bold</b> and <i>italic</i> and <code>code</code></p>",
        context: "Paragraph", group: "g1", type: "text",
      }),
    ]
    expect(rebuildMarkdown(cells)).toBe("This is **bold** and *italic* and `code`")
  })

  it("preserves strikethrough from translatedHtml", () => {
    const cells: ExportCell[] = [
      makeCell({
        id: "c1",
        translated: "try struck",
        translatedHtml: "<p>try <s>struck</s></p>",
        context: "Paragraph", group: "g1", type: "text",
      }),
    ]
    expect(rebuildMarkdown(cells)).toBe("try ~~struck~~")
  })

  it("preserves underline as HTML tag (no markdown equivalent)", () => {
    const cells: ExportCell[] = [
      makeCell({
        id: "c1",
        translated: "here under",
        translatedHtml: "<p>here <u>under</u></p>",
        context: "Paragraph", group: "g1", type: "text",
      }),
    ]
    expect(rebuildMarkdown(cells)).toBe("here <u>under</u>")
  })

  it("falls back to plain translated text when no translatedHtml", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", translated: "plain text", context: "Paragraph", group: "g1", type: "text" }),
    ]
    expect(rebuildMarkdown(cells)).toBe("plain text")
  })
})

describe("rebuildVtt", () => {
  it("emits WEBVTT header and cues", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", translated: "Bonjour", context: "00:00:01.000 --> 00:00:04.000", group: "g1", type: "cue" }),
      makeCell({ id: "c2", translated: "Au revoir", context: "00:00:05.000 --> 00:00:08.000", group: "g2", type: "cue" }),
    ]
    expect(rebuildVtt(cells)).toBe(
      "WEBVTT\n\n" +
      "00:00:01.000 --> 00:00:04.000\nBonjour\n\n" +
      "00:00:05.000 --> 00:00:08.000\nAu revoir"
    )
  })

  it("falls back to original for empty translations", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", original: "Hello", translated: "", context: "00:00:01.000 --> 00:00:04.000", group: "g1", type: "cue" }),
    ]
    expect(rebuildVtt(cells)).toBe("WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello")
  })

  it("handles empty input", () => {
    expect(rebuildVtt([])).toBe("WEBVTT")
  })
})

describe("rebuildSrt", () => {
  it("emits numbered cues with timestamps", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", translated: "Bonjour", context: "00:00:01,000 --> 00:00:04,000", group: "g1", type: "cue" }),
      makeCell({ id: "c2", translated: "Au revoir", context: "00:00:05,000 --> 00:00:08,000", group: "g2", type: "cue" }),
    ]
    expect(rebuildSrt(cells)).toBe(
      "1\n00:00:01,000 --> 00:00:04,000\nBonjour\n\n" +
      "2\n00:00:05,000 --> 00:00:08,000\nAu revoir"
    )
  })

  it("handles empty input", () => {
    expect(rebuildSrt([])).toBe("")
  })
})

describe("rebuildUsfm", () => {
  it("emits \\id, \\c, \\v markers from context", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", translated: "Au commencement.", context: "GEN 1:1", group: "g1", type: "verse" }),
      makeCell({ id: "c2", translated: "La terre était.", context: "GEN 1:2", group: "g2", type: "verse" }),
    ]
    expect(rebuildUsfm(cells)).toBe(
      "\\id GEN\n\\c 1\n\\v 1 Au commencement.\n\\v 2 La terre était."
    )
  })

  it("emits \\s for section headings", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", translated: "La Création", context: "GEN 1", group: "g1", type: "heading" }),
      makeCell({ id: "c2", translated: "Au commencement.", context: "GEN 1:1", group: "g2", type: "verse" }),
    ]
    expect(rebuildUsfm(cells)).toBe(
      "\\id GEN\n\\c 1\n\\s La Création\n\\v 1 Au commencement."
    )
  })

  it("emits \\mt for paratext", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", translated: "Genèse", context: "GEN", group: "g1", type: "paratext" }),
      makeCell({ id: "c2", translated: "Verse", context: "GEN 1:1", group: "g2", type: "verse" }),
    ]
    expect(rebuildUsfm(cells)).toBe(
      "\\id GEN\n\\mt Genèse\n\\c 1\n\\v 1 Verse"
    )
  })

  it("handles chapter transitions", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", translated: "V1 of ch1", context: "GEN 1:1", group: "g1", type: "verse" }),
      makeCell({ id: "c2", translated: "V1 of ch2", context: "GEN 2:1", group: "g2", type: "verse" }),
    ]
    expect(rebuildUsfm(cells)).toBe(
      "\\id GEN\n\\c 1\n\\v 1 V1 of ch1\n\\c 2\n\\v 1 V1 of ch2"
    )
  })

  it("handles multiple books", () => {
    const cells: ExportCell[] = [
      makeCell({ id: "c1", translated: "Gen verse", context: "GEN 1:1", group: "g1", type: "verse" }),
      makeCell({ id: "c2", translated: "Exo verse", context: "EXO 1:1", group: "g2", type: "verse" }),
    ]
    expect(rebuildUsfm(cells)).toBe(
      "\\id GEN\n\\c 1\n\\v 1 Gen verse\n\n\\id EXO\n\\c 1\n\\v 1 Exo verse"
    )
  })

  it("handles empty input", () => {
    expect(rebuildUsfm([])).toBe("")
  })
})
