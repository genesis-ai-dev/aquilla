import { v4 as uuid } from "uuid"
import type { CellUnit, TranslatableString } from "./core-types"
import { splitIntoSegments } from "./text-splitter"

/**
 * Plain-text blocks for `cellUnit: "paragraph"` (AQU-1720).
 *
 * A .txt file uses one of two paragraph conventions and the right split
 * differs between them, so pick by what the file actually contains:
 *
 * - **Blank-line separated** (a blank line somewhere in the file): a blank line
 *   is the paragraph break and a bare newline is a soft wrap, so wrapped lines
 *   rejoin with a space. Same convention as Markdown.
 * - **One paragraph per line** (no blank line anywhere — a dubbing transcript
 *   exported line-per-block): every non-empty line is its own paragraph.
 *
 * Guessing wrong in either direction is visible and wrong: collapsing a
 * line-per-block transcript gives one enormous cell, and splitting a wrapped
 * paragraph per line gives a cell per wrapped line.
 *
 * Question 51 (AQU-2544): a blank line at the very start or end of the file
 * separates nothing and is ignored, so one extra Enter no longer flips a
 * line-per-block file into a single paragraph.
 */
function paragraphBlocks(normalized: string): string[] {
  const body = normalized.trim()
  const hasBlankLine = /\n[ \t]*\n/.test(body)
  if (!hasBlankLine) {
    return body.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
  }
  return body
    .split(/\n[ \t]*\n+/)
    .map((block) => block.split("\n").map((line) => line.trim()).filter(Boolean).join(" "))
    .filter((block) => block.length > 0)
}

export function extractPlaintextStrings(
  content: string,
  options?: { cellUnit?: CellUnit },
): TranslatableString[] {
  // AQU-1720: "paragraph" makes the paragraph the cell — no sentence split and
  // no length cap, so a dubbing clip is never cut at a comma. "sentence" (the
  // default) is the long-standing segmenting behaviour, untouched.
  const cellUnit = options?.cellUnit ?? "sentence"
  // Normalize CRLF/CR so Windows-authored files split into paragraphs instead
  // of importing as one giant block (blank-line detection needs plain \n).
  const normalized = content.replace(/\r\n?/g, "\n")
  // Question 51 (AQU-2544, Sam to confirm; this and the trim in
  // `paragraphBlocks` are all of it): on the Sentence setting every line is
  // its own paragraph, blank lines or not, and blank lines are skipped. A long
  // line is still cut into sentences inside itself. Before, Sentence split
  // only at blank lines and joined the lines between them into cells of up
  // to 200 characters, so a file written one sentence per line, and its
  // translation written the same way, could never line up. The cost:
  // hard-wrapped text comes in one cell per wrapped line. (Before question
  // 51 this read `normalized.split(/\n\n+/)`.)
  const paragraphs = cellUnit === "paragraph"
    ? paragraphBlocks(normalized)
    : normalized.split("\n").filter((line) => line.trim().length > 0)
  const results: TranslatableString[] = []

  paragraphs.forEach((para, index) => {
    const trimmed = para.trim()
    const segments = splitIntoSegments(trimmed, undefined, cellUnit)

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      results.push({
        id: uuid(),
        original: seg.text,
        translated: "",
        context: `Paragraph ${index + 1}`,
        group: seg.group,
        type: "text",
        // D2: first sub-cell of each paragraph block carries paragraphStart; continuations do not.
        ...(i === 0 ? { paragraphStart: true } : {}),
      })
    }
  })

  return results
}
