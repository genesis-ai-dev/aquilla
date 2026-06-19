/**
 * D1/D2 pipeline integration tests: USFM paragraph detection → TranslatableString
 * → deriveParagraphs grouping.
 *
 * WHY these tests exist (D1, D2):
 *   - Paragraph is a GROUPING over cells, never a re-segmentation of them.
 *     The verse-cell is the alignment unit and must NOT be split below —
 *     the alignment/BT/terminology stack depends on source↔target cell
 *     correspondence. \p and \v are orthogonal in USFM.
 *   - paragraphStart on a TranslatableString is the signal deriveParagraphs
 *     uses to begin a new group. Every verse that follows a \p/\q/\m/\b/\nb/
 *     \pi/\li in USFM must carry paragraphStart: true; continuation verses must
 *     not. No verse is ever split.
 *
 * See docs/superpowers/specs/2026-06-18-paragraph-drafting-retrieval-context-design.md (D1,D2).
 */
import { describe, it, expect } from "vitest"
import { parseUsfmLossless } from "../usfm-lossless"
import { deriveParagraphs } from "../paragraphs"
import type { ParagraphCell } from "../paragraphs"
import { v7 as uuidv7 } from "uuid"
import type { TranslatableString } from "../types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a lossless parse into a minimal TranslatableString[] (same mapping
 * as usfmSectionToStrings in import.ts, minus the dedup logic — sufficient
 * for paragraph-grouping tests).
 */
function usfmToStrings(raw: string): TranslatableString[] {
  const doc = parseUsfmLossless(raw)
  const bookId = doc.bookId || "unknown"
  const allSpans = [
    ...doc.verses.map((v) => ({
      order: v.textStart,
      ref: v.ref,
      text: v.text.trim(),
      section: `${bookId} ${v.chapter}`,
      type: "verse" as const,
      paragraphStart: v.paragraphStart,
    })),
    ...doc.headings.map((h) => ({
      order: h.textStart,
      ref: h.ref,
      text: h.text.trim(),
      section: h.chapter > 0 ? `${bookId} ${h.chapter}` : bookId,
      type: h.kind as TranslatableString["type"],
      paragraphStart: undefined as boolean | undefined,
    })),
  ].sort((a, b) => a.order - b.order)
  return allSpans.map((s) => ({
    id: uuidv7(),
    original: s.text,
    translated: "",
    context: s.ref,
    group: s.ref,
    section: s.section,
    globalReferences: [s.ref],
    type: s.type,
    ...(s.paragraphStart ? { paragraphStart: true } : {}),
  }))
}

/** Convert TranslatableString[] into ParagraphCell[] for deriveParagraphs. */
function toParagraphCells(strings: TranslatableString[], fileId = "f1"): ParagraphCell[] {
  return strings.map((s) => ({ id: s.id, fileId, paragraphStart: s.paragraphStart }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("USFM → paragraphStart → deriveParagraphs (D1/D2)", () => {
  it("prose chapter: \\p before first verse, continuation verses form one group", () => {
    const raw = `\\id GEN
\\c 1
\\p
\\v 1 In the beginning God created the heavens and the earth.
\\v 2 The earth was without form and empty.
\\v 3 And God said, Let there be light.`
    const strings = usfmToStrings(raw)
    const verseStrings = strings.filter((s) => s.type === "verse")
    expect(verseStrings).toHaveLength(3)
    // Only verse 1 gets paragraphStart
    expect(verseStrings[0].paragraphStart).toBe(true)
    expect(verseStrings[1].paragraphStart).toBeUndefined()
    expect(verseStrings[2].paragraphStart).toBeUndefined()

    // deriveParagraphs groups all three into one paragraph
    const cells = toParagraphCells(verseStrings)
    const groups = deriveParagraphs(cells)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toHaveLength(3)
  })

  it("multiple \\p blocks group verses correctly", () => {
    // Ruth 1:1-5 pattern: two prose paragraphs
    const raw = `\\id RUT
\\c 1
\\p
\\v 1 In the days when the judges ruled there was a famine.
\\v 2 The name of the man was Elimelech.
\\p
\\v 3 Elimelech the husband of Naomi died.
\\v 4 They took Moabite wives.
\\v 5 They died also.`
    const strings = usfmToStrings(raw)
    const verses = strings.filter((s) => s.type === "verse")
    expect(verses).toHaveLength(5)
    expect(verses[0].paragraphStart).toBe(true)
    expect(verses[1].paragraphStart).toBeUndefined()
    expect(verses[2].paragraphStart).toBe(true)
    expect(verses[3].paragraphStart).toBeUndefined()
    expect(verses[4].paragraphStart).toBeUndefined()

    const groups = deriveParagraphs(toParagraphCells(verses))
    expect(groups).toHaveLength(2)
    expect(groups[0]).toHaveLength(2)
    expect(groups[1]).toHaveLength(3)
  })

  it("poetry (\\q1/\\q2) openings are grouped correctly; intra-verse \\q* never bleeds", () => {
    // Psalm 1:1-3: verse 1 has intra-verse \\q markers; verse 2 must NOT
    // inherit a paragraphStart from them. This is the critical D1 anti-split check.
    const raw = `\\id PSA
\\c 1
\\q1
\\v 1 Blessed is the man
\\q1 who walks not in the counsel of the wicked
\\q2 nor stands in the way of sinners
\\q3 nor sits in the seat of scoffers
\\v 2 but his delight is in the law of the LORD
\\q1 and on his law he meditates day and night
\\q1
\\v 3 He is like a tree planted by streams of water`
    const strings = usfmToStrings(raw)
    const verses = strings.filter((s) => s.type === "verse")
    expect(verses).toHaveLength(3)

    // Verse 1: \\q1 before \\v 1 → paragraph-start
    expect(verses[0].paragraphStart).toBe(true)
    // Verse 1 text must be intact (not split at internal \\q* markers — D1)
    expect(verses[0].original).toContain("\\q1 who walks not in the counsel")
    expect(verses[0].original).toContain("\\q2 nor stands in the way")

    // Verse 2: the intra-verse \\q1/\\q2/\\q3 inside verse 1 must NOT bleed.
    // However the \\q1 between verse 2 and verse 3 DOES mark verse 3.
    expect(verses[1].paragraphStart).toBeUndefined()

    // Verse 3: \\q1 between \\v 2 text and \\v 3 → paragraph-start
    expect(verses[2].paragraphStart).toBe(true)

    // deriveParagraphs: verse 1 alone, then verses 2+3? No — verse 2 has no
    // paragraphStart so it continues verse 1's group; verse 3 starts a new group.
    const groups = deriveParagraphs(toParagraphCells(verses))
    expect(groups).toHaveLength(2)
    expect(groups[0].length).toBe(2) // verses 1 & 2
    expect(groups[1].length).toBe(1) // verse 3
  })

  it("\\b (blank-line) marker between verses triggers paragraphStart on the following verse", () => {
    const raw = `\\id PSA
\\c 119
\\p
\\v 1 Blessed are those whose way is blameless.
\\b
\\q1
\\v 9 How can a young man keep his way pure?`
    const strings = usfmToStrings(raw)
    const verses = strings.filter((s) => s.type === "verse")
    expect(verses[0].paragraphStart).toBe(true)
    expect(verses[1].paragraphStart).toBe(true)
    const groups = deriveParagraphs(toParagraphCells(verses))
    expect(groups).toHaveLength(2)
  })

  it("verse count is never changed by paragraph detection (D1: no split below verse)", () => {
    // A complex passage with multiple \\p, \\q, \\b, \\nb markers.
    // The ONLY thing that should change from a plain parse is paragraphStart
    // on some verses. The total verse count must be identical.
    const raw = `\\id MAT
\\c 5
\\p
\\v 1 Seeing the crowds he went up on the mountain.
\\p
\\v 2 And he opened his mouth and taught them saying.
\\q1
\\v 3 Blessed are the poor in spirit.
\\q1 for theirs is the kingdom of heaven.
\\q1
\\v 4 Blessed are those who mourn.
\\nb
\\v 5 Blessed are the meek.`
    const doc = parseUsfmLossless(raw)
    // Baseline: parser must produce exactly 5 verses regardless of markers
    expect(doc.verses).toHaveLength(5)

    const strings = usfmToStrings(raw)
    const verses = strings.filter((s) => s.type === "verse")
    expect(verses).toHaveLength(5)

    // Check paragraph grouping makes sense
    const groups = deriveParagraphs(toParagraphCells(verses))
    // \\p before v1, \\p before v2, \\q1 before v3, \\q1 before v4, \\nb before v5
    // each verse has a paragraph marker → 5 separate groups
    expect(groups).toHaveLength(5)
    for (const g of groups) {
      expect(g).toHaveLength(1)
    }
  })
})
