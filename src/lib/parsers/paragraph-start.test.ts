/**
 * D2 paragraph-start marker tests (non-scripture: md / txt / docx).
 *
 * Intent (not just behavior):
 *   - Every natural paragraph gets exactly ONE cell with paragraphStart:true —
 *     the alignment/BT/terminology stack will use this to scope multi-cell drafts.
 *   - When a paragraph is over-long and sub-splits, all sub-cells share ONE group
 *     and only the FIRST sub-cell carries paragraphStart:true. Continuations must
 *     NOT carry it (deriveParagraphs would treat them as new paragraphs — wrong).
 *   - buildBulkCellsWithSpeakers must pass paragraphStart through to BulkImportCell
 *     so the field survives import.
 *   - deriveParagraphs over the produced cells must group each source paragraph
 *     into exactly one group.
 *
 * See docs/superpowers/specs/2026-06-18-paragraph-drafting-retrieval-context-design.md (D1,D2).
 */

import { describe, it, expect } from "vitest"
import { extractMarkdownStrings } from "./markdown"
import { extractPlaintextStrings } from "./plaintext"
import { deriveParagraphs } from "./paragraphs"
import { buildBulkCellsWithSpeakers } from "../import"
import { usfmSectionToStrings } from "./parse-text-formats"
import type { ParagraphCell } from "./paragraphs"

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build ParagraphCells from TranslatableStrings for use with deriveParagraphs. */
function toParagraphCells(strings: { id: string; paragraphStart?: boolean }[], fileId = "f1"): ParagraphCell[] {
  return strings.map((s) => ({ id: s.id, fileId, ...(s.paragraphStart ? { paragraphStart: true } : {}) }))
}

// ── Markdown ──────────────────────────────────────────────────────────────────

describe("extractMarkdownStrings — paragraphStart (D2)", () => {
  it("a normal-length markdown paragraph produces ONE cell with paragraphStart:true", () => {
    const result = extractMarkdownStrings("Hello world, this is a short paragraph.")
    expect(result).toHaveLength(1)
    expect(result[0].paragraphStart).toBe(true)
  })

  it("each top-level block (heading, paragraph, list item) starts its own paragraph", () => {
    const md = "# Title\n\nFirst paragraph.\n\n- A list item"
    const result = extractMarkdownStrings(md)
    // Every cell must carry paragraphStart because each is the first (and only) cell
    // of its block — a new paragraph boundary precedes each.
    expect(result.every((s) => s.paragraphStart === true)).toBe(true)
  })

  it("two consecutive paragraphs each get paragraphStart:true on their first cells", () => {
    const md = "First paragraph.\n\nSecond paragraph."
    const result = extractMarkdownStrings(md)
    expect(result).toHaveLength(2)
    expect(result[0].paragraphStart).toBe(true)
    expect(result[1].paragraphStart).toBe(true)
  })

  it("an over-long paragraph sub-splits; all sub-cells share ONE group; only first has paragraphStart", () => {
    // 30 x "This is a long sentence." = 720 chars > default maxLength 200
    const longParagraph = Array(30).fill("This is a long sentence.").join(" ")
    const result = extractMarkdownStrings(longParagraph)

    expect(result.length).toBeGreaterThan(1)

    // All sub-cells share one group
    const groups = new Set(result.map((s) => s.group))
    expect(groups.size).toBe(1)

    // Only the first sub-cell carries paragraphStart
    expect(result[0].paragraphStart).toBe(true)
    for (let i = 1; i < result.length; i++) {
      expect(result[i].paragraphStart).toBeUndefined()
    }
  })

  it("sub-split continuation cells must NOT have paragraphStart (would mislead deriveParagraphs)", () => {
    // This test encodes the intent: if continuation cells had paragraphStart:true,
    // deriveParagraphs would think each sub-cell is a new paragraph — breaking
    // the multi-cell draft scoping that D2 was designed to enable.
    const longParagraph = Array(30).fill("Sentence here.").join(" ")
    const result = extractMarkdownStrings(longParagraph)

    const cells = toParagraphCells(result)
    const groups = deriveParagraphs(cells)

    // All sub-cells from the same source paragraph must land in ONE group.
    expect(groups).toHaveLength(1)
    expect(groups[0]).toHaveLength(result.length)
  })

  it("deriveParagraphs groups two-paragraph markdown output into two groups", () => {
    const md = "First paragraph.\n\nSecond paragraph."
    const result = extractMarkdownStrings(md)
    const cells = toParagraphCells(result)
    const groups = deriveParagraphs(cells)

    expect(groups).toHaveLength(2)
    expect(groups[0]).toHaveLength(1)
    expect(groups[1]).toHaveLength(1)
  })
})

// ── Plaintext ─────────────────────────────────────────────────────────────────

describe("extractPlaintextStrings — paragraphStart (D2)", () => {
  it("a short paragraph produces ONE cell with paragraphStart:true", () => {
    const result = extractPlaintextStrings("Hello world.")
    expect(result).toHaveLength(1)
    expect(result[0].paragraphStart).toBe(true)
  })

  it("multiple paragraphs each start with paragraphStart:true", () => {
    const result = extractPlaintextStrings("First.\n\nSecond.\n\nThird.")
    expect(result).toHaveLength(3)
    expect(result[0].paragraphStart).toBe(true)
    expect(result[1].paragraphStart).toBe(true)
    expect(result[2].paragraphStart).toBe(true)
  })

  it("over-long paragraph sub-splits; only first sub-cell has paragraphStart", () => {
    const longPara = Array(30).fill("Sentence here.").join(" ")
    const result = extractPlaintextStrings(longPara)

    expect(result.length).toBeGreaterThan(1)
    const groups = new Set(result.map((s) => s.group))
    expect(groups.size).toBe(1)

    expect(result[0].paragraphStart).toBe(true)
    for (let i = 1; i < result.length; i++) {
      expect(result[i].paragraphStart).toBeUndefined()
    }
  })

  it("deriveParagraphs over plaintext output groups each source paragraph correctly", () => {
    // Two paragraphs; second one over-long and sub-splits.
    const p2 = Array(30).fill("Long sentence.").join(" ")
    const result = extractPlaintextStrings("Short paragraph.\n\n" + p2)
    const cells = toParagraphCells(result)
    const groups = deriveParagraphs(cells)

    // Must have exactly 2 paragraph groups (one per source paragraph).
    expect(groups).toHaveLength(2)
    // First group: 1 cell (short paragraph)
    expect(groups[0]).toHaveLength(1)
    // Second group: all sub-cells of the long paragraph
    expect(groups[1]).toHaveLength(result.length - 1)
  })
})

// ── buildBulkCellsWithSpeakers carry-through ─────────────────────────────────

describe("buildBulkCellsWithSpeakers — paragraphStart carry-through (D2)", () => {
  it("carries paragraphStart:true from TranslatableString to BulkImportCell", () => {
    const strings = extractPlaintextStrings("First paragraph.\n\nSecond paragraph.")
    const { cells } = buildBulkCellsWithSpeakers(strings)

    expect(cells).toHaveLength(2)
    expect(cells[0].paragraphStart).toBe(true)
    expect(cells[1].paragraphStart).toBe(true)
  })

  it("does NOT set paragraphStart on continuation sub-cells after carry-through", () => {
    const longPara = Array(30).fill("Sentence here.").join(" ")
    const strings = extractPlaintextStrings(longPara)
    const { cells } = buildBulkCellsWithSpeakers(strings)

    expect(cells.length).toBeGreaterThan(1)
    expect(cells[0].paragraphStart).toBe(true)
    for (let i = 1; i < cells.length; i++) {
      // Must be absent (not set to false) to match the optional-field pattern.
      expect(cells[i].paragraphStart).toBeUndefined()
    }
  })

  it("does not set paragraphStart when TranslatableString has none (e.g. scripture strings)", () => {
    // TranslatableStrings without paragraphStart (e.g. USFM-produced) must not
    // suddenly get the field in the BulkImportCell.
    const strings = [
      { id: "v1", original: "In the beginning", translated: "", context: "GEN 1:1", group: "g1", type: "verse" as const },
      { id: "v2", original: "The earth was formless", translated: "", context: "GEN 1:2", group: "g1", type: "verse" as const },
    ]
    const { cells } = buildBulkCellsWithSpeakers(strings)
    expect(cells[0].paragraphStart).toBeUndefined()
    expect(cells[1].paragraphStart).toBeUndefined()
  })
})

// ── AQU-2184: paragraphMarker along the same commit path ─────────────────────
//
// The parser's `paragraphMarker` is worthless unless it survives the whole way
// into `cells.metadata`, because the HTML export reads it from there (via
// `CellData.paragraphMarker`) and the marker itself is gone by then — it lives
// between verse spans in the raw USFM, not inside any cell's text. So this
// walks the real producer's output through the real consumer: USFM in,
// `BulkImportCell.metadata` out.

describe("USFM → BulkImportCell.metadata — paragraphMarker (AQU-2184)", () => {
  const PSALM = `\\id PSA
\\c 1
\\q1
\\v 1 Blessed is the man
\\q2 who walks not in the counsel
\\q1
\\v 2 but his delight is in the law
\\p
\\v 3 He is like a tree
\\v 4 planted by the water`

  it("carries each verse's marker from the raw USFM into the cell's metadata", () => {
    const { strings } = usfmSectionToStrings(PSALM)
    const { cells } = buildBulkCellsWithSpeakers(strings, { fileName: "psa.usfm", fileType: "usfm" })

    const byRef = new Map(cells.map((c, i) => [strings[i].group, c]))
    expect(byRef.get("PSA 1:1")?.metadata?.paragraphMarker).toBe("q1")
    expect(byRef.get("PSA 1:2")?.metadata?.paragraphMarker).toBe("q1")
    expect(byRef.get("PSA 1:3")?.metadata?.paragraphMarker).toBe("p")
    // A continuation verse opens no paragraph, so it carries no marker.
    expect(byRef.get("PSA 1:4")?.metadata?.paragraphMarker).toBeUndefined()
    expect(byRef.get("PSA 1:4")?.paragraphStart).toBeUndefined()
  })

  it("leaves the field off entirely for a parser that supplies no marker", () => {
    const strings = extractPlaintextStrings("First paragraph.\n\nSecond paragraph.")
    const { cells } = buildBulkCellsWithSpeakers(strings)
    expect(cells[0].paragraphStart).toBe(true)
    expect(cells[0].metadata).not.toHaveProperty("paragraphMarker")
  })
})
